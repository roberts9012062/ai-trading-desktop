/**
 * eval-vm.wgsl —— GPU 粗排因子求值与指标(M4)
 *
 * 两个 compute 阶段:
 * - evalVM(@256):栈式执行 token 序列(窗口算子按线程各自回看窗口),
 *   末级做 workgroup 树形归约求 mean/std(全样本归一化口径,与 vm.py 现状一致);
 * - evalMetrics(@64):每线程一个候选,保留时间序列/Kahan 的累加顺序。
 *
 * 算子分派用 if/else 而非 switch:WGSL 不支持多值 case 分组,且分支条件
 * 里要比较多个算子编号。算子编号 = OPS_CONFIG 顺序(顺序冻结不可重排,
 * 与 tokens.ts 镜像)。EMA 不支持(串行递推),JS 侧已过滤,shader 内兜底判 fail。
 *
 * ⚠️ 本文件产物只用于排序:对外暴露的一切数字出自 Pyodide f64 精算。
 */

import { OPS } from "../tokens"

export const EVAL_VM_WGSL = /* wgsl */ `
const LEVELS: u32 = 8u;   // 栈深上限(树深≤6 → 栈深≤7,留 1 余量)
const TMP_LVL: u32 = 8u;  // 第 9 层作一元算子的临时层(避免同层读写竞争)
const W: u32 = 256u;      // workgroup 大小(2 的幂,归约用)
const PAD: u32 = 0xFFFFFFFFu;

// 算子 id(与 OPS_CONFIG / tokens.ts 同序)
const OP_ADD = 0u;  const OP_SUB = 1u;  const OP_MUL = 2u;  const OP_DIV = 3u;
const OP_MIN = 4u;  const OP_MAX = 5u;
const OP_ABS = 6u;  const OP_NEG = 7u;  const OP_SIGN = 8u; const OP_SQRT = 9u;
const OP_SLOG = 10u; const OP_SIGM = 11u; const OP_TANH = 12u;
const OP_MA5 = 13u; const OP_MA10 = 14u; const OP_MA20 = 15u;
const OP_STD10 = 16u; const OP_STD20 = 17u;
const OP_MAX10 = 18u; const OP_MAX20 = 19u; const OP_MIN10 = 20u;
const OP_RANK10 = 21u; const OP_RANK20 = 22u; const OP_ZS20 = 23u;
const OP_D1 = 24u; const OP_D5 = 25u; const OP_ATR = 26u;
const OP_LAG1 = 27u; const OP_LAG5 = 28u; const OP_CORR = 29u;
const OP_MA60 = 30u; const OP_STD60 = 31u; const OP_ZS60 = 32u; const OP_RANK60 = 33u;
const OP_DMN20 = 34u; const OP_BETA = 35u; const OP_RESID = 36u; const OP_STEP = 37u;
const OP_EMA5 = 38u; const OP_EMA20 = 39u;
const OP_CRANK20 = 40u; const OP_CRANK60 = 41u;
const OP_DECAY10 = 42u; const OP_DECAY20 = 43u;

struct Params {
  T: u32,        // 训练段长度
  F: u32,        // 特征数
  P: u32,        // 本批候选数
  MAXT: u32,     // token 定长
  LEVELS9: u32,  // 栈层数+临时层(=9)
  periods: f32,
  cost: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> feat: array<f32>;       // [F*T] 行主序
@group(0) @binding(2) var<storage, read> tokens: array<u32>;     // [P*MAXT]
@group(0) @binding(3) var<storage, read> ret: array<f32>;        // [T]
@group(0) @binding(4) var<storage, read_write> stk: array<f32>;  // [P*9*T]
@group(0) @binding(5) var<storage, read_write> factorOut: array<f32>; // [P*T] 原始(未归一)
@group(0) @binding(6) var<storage, read_write> stats: array<f32>;     // [P*2] mean,std(<0=失败)
@group(0) @binding(7) var<storage, read_write> metrics: array<f32>;   // [P*9] 末位=composite,-999=无效

var<workgroup> redA: array<f32, 256>;
var<workgroup> redB: array<f32, 256>;

fn sgn(v: f32) -> f32 {
  if (v > 0.0) { return 1.0; }
  if (v < 0.0) { return -1.0; }
  return 0.0;
}

fn sane(v: f32) -> f32 {
  // nan_to_num:nan→0,+inf→1,-inf→-1
  if (v != v) { return 0.0; }
  if (v > 3.4e38) { return 1.0; }
  if (v < -3.4e38) { return -1.0; }
  return v;
}

fn winOf(op: u32) -> u32 {
  if (op == OP_CRANK20 || op == OP_DECAY20) { return 20u; }
  if (op == OP_CRANK60) { return 60u; }
  if (op == OP_DECAY10) { return 10u; }
  if (op == OP_MA5) { return 5u; }
  if (op == OP_MA10 || op == OP_STD10 || op == OP_RANK10 || op == OP_MAX10 || op == OP_MIN10) { return 10u; }
  if (op == OP_MA20 || op == OP_STD20 || op == OP_RANK20 || op == OP_ZS20 || op == OP_DMN20 || op == OP_MAX20) { return 20u; }
  if (op == OP_MA60 || op == OP_STD60 || op == OP_RANK60 || op == OP_ZS60) { return 60u; }
  return 20u;
}

// ── Pass A:栈式求值 + 全样本 mean/std ────────────────────────
@compute @workgroup_size(256)
fn evalVM(@builtin(workgroup_id) gid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let p = gid.x;
  let lid = lid3.x;
  let T = params.T;
  let MAXT = params.MAXT;
  if (p >= params.P) { return; }
  let stkBase = p * params.LEVELS9 * T;

  var sp: u32 = 0u;
  var fail = false;

  for (var k: u32 = 0u; k < MAXT; k = k + 1u) {
    if (fail) { break; }
    let tok = tokens[p * MAXT + k];
    if (tok == PAD) { continue; }

    if (tok < 64u) {
      if (tok >= params.F) { fail = true; break; }
      let dst = stkBase + sp * T;
      let fb = tok * T;
      for (var t = lid; t < T; t = t + W) { stk[dst + t] = feat[fb + t]; }
      storageBarrier();
      sp = sp + 1u;
      if (sp > LEVELS) { fail = true; break; } // 留出 TMP 层
      continue;
    }

    let op = tok - 64u;
    if (op >= ${OPS.length}u) { fail = true; break; }
    let isBin = (op <= 5u) || (op == OP_CORR) || (op == OP_BETA) || (op == OP_RESID);

    if (isBin) {
      if (sp < 2u) { fail = true; break; }
      let a = stkBase + (sp - 2u) * T;
      let b = stkBase + (sp - 1u) * T;
      let rolling = op == OP_CORR || op == OP_BETA || op == OP_RESID;
      let dst = select(a, stkBase + TMP_LVL * T, rolling);
      for (var t = lid; t < T; t = t + W) {
        var v: f32;
        if (op == OP_ADD) { v = stk[a + t] + stk[b + t]; }
        else if (op == OP_SUB) { v = stk[a + t] - stk[b + t]; }
        else if (op == OP_MUL) { v = stk[a + t] * stk[b + t]; }
        else if (op == OP_DIV) { v = stk[a + t] / max(abs(stk[b + t]), 1e-8) * sgn(stk[b + t] + 1e-12); }
        else if (op == OP_MIN) { v = min(stk[a + t], stk[b + t]); }
        else if (op == OP_MAX) { v = max(stk[a + t], stk[b + t]); }
        else {
          // CORR/BETA/RESID:窗口 20 滚动回归族
          let lo = select(0u, t - 19u, t >= 19u);
          var sx = 0.0; var sy = 0.0; var sxx = 0.0; var syy = 0.0; var sxy = 0.0;
          for (var i = lo; i <= t; i = i + 1u) {
            let x = stk[a + i]; let y = stk[b + i];
            sx = sx + x; sy = sy + y; sxx = sxx + x * x; syy = syy + y * y; sxy = sxy + x * y;
          }
          let c = f32(t - lo + 1u);
          let mx = sx / c; let my = sy / c;
          let vx = max(sxx / c - mx * mx, 0.0);
          let vy = max(syy / c - my * my, 0.0);
          let cov = sxy / c - mx * my;
          if (op == OP_CORR) {
            if (t - lo + 1u >= 2u && sqrt(vx) >= 1e-9 && sqrt(vy) >= 1e-9) {
              v = cov / (sqrt(vx) * sqrt(vy));
            } else { v = 0.0; }
          } else if (op == OP_BETA) {
            v = select(0.0, cov / max(vy, 1e-30), vy > 1e-12);
          } else {
            let beta = select(0.0, cov / max(vy, 1e-30), vy > 1e-12);
            v = (stk[a + t] - mx) - beta * (stk[b + t] - my);
          }
        }
        stk[dst + t] = sane(v);
      }
      storageBarrier();
      if (rolling) {
        for (var t = lid; t < T; t = t + W) { stk[a + t] = stk[dst + t]; }
        storageBarrier();
      }
      sp = sp - 1u;
    } else {
      // 一元算子:读层 sp-1。窗口/滞后类写临时层后回拷(避免同层读写竞争)
      if (sp < 1u) { fail = true; break; }
      if (op == OP_EMA5 || op == OP_EMA20) { fail = true; break; }
      let src = stkBase + (sp - 1u) * T;
      let tmp = stkBase + TMP_LVL * T;
      let elemwise = (op <= OP_TANH) || (op == OP_ATR) || (op == OP_STEP);
      let dst = select(tmp, src, elemwise);
      let w = winOf(op);
      for (var t = lid; t < T; t = t + W) {
        var v: f32;
        if (op == OP_ABS) { v = abs(stk[src + t]); }
        else if (op == OP_NEG) { v = -stk[src + t]; }
        else if (op == OP_SIGN) { v = sgn(stk[src + t]); }
        else if (op == OP_SQRT) { let x = stk[src + t]; v = sgn(x) * sqrt(abs(x)); }
        else if (op == OP_SLOG) { let x = stk[src + t]; v = sgn(x) * log(1.0 + abs(x)); }
        else if (op == OP_SIGM) { let x = clamp(stk[src + t], -30.0, 30.0); v = 2.0 / (1.0 + exp(-x)) - 1.0; }
        else if (op == OP_TANH) { v = tanh(clamp(stk[src + t], -30.0, 30.0)); }
        else if (op == OP_ATR) { let m = max(abs(stk[src + t]), 1e-9); v = sgn(m) * log(1.0 + m); }
        else if (op == OP_STEP) { v = select(0.0, 1.0, stk[src + t] > 0.0); }
        else if (op == OP_D1 || op == OP_D5) {
          let n = select(5u, 1u, op == OP_D1);
          v = 0.0;
          if (t >= n) { v = stk[src + t] - stk[src + t - n]; }
        }
        else if (op == OP_LAG1 || op == OP_LAG5) {
          let n = select(5u, 1u, op == OP_LAG1);
          v = 0.0;
          if (t >= n) { v = stk[src + t - n]; }
        }
        else if (op == OP_MAX10 || op == OP_MAX20 || op == OP_MIN10) {
          let lo = select(0u, t - w + 1u, t + 1u >= w);
          var acc = stk[src + lo];
          for (var i = lo + 1u; i <= t; i = i + 1u) {
            if (op == OP_MIN10) { acc = min(acc, stk[src + i]); }
            else { acc = max(acc, stk[src + i]); }
          }
          v = acc;
        }
        else if (op == OP_CRANK20 || op == OP_CRANK60 || op == OP_DECAY10 || op == OP_DECAY20) {
          let lo = select(0u, t - w + 1u, t + 1u >= w);
          var acc = 0.0;
          let cur = stk[src + t];
          for (var i = lo; i <= t; i = i + 1u) {
            if (op == OP_CRANK20 || op == OP_CRANK60) {
              let eps = 1e-6 * max(1.0, abs(cur));
              if (stk[src + i] < cur - eps) { acc = acc + 1.0; }
              else if (abs(stk[src + i] - cur) <= eps) { acc = acc + 0.5; }
            } else { acc = acc + stk[src + i] * f32(i - lo + 1u); }
          }
          let count = f32(t - lo + 1u);
          if (op == OP_CRANK20 || op == OP_CRANK60) { v = 2.0 * acc / count - 1.0; }
          else { v = acc / (count * (count + 1.0) / 2.0); }
        }
        else if (op == OP_RANK10 || op == OP_RANK20 || op == OP_RANK60) {
          let lo = select(0u, t - w + 1u, t + 1u >= w);
          var cnt: u32 = 0u;
          let cur = stk[src + t];
          for (var i = lo; i <= t; i = i + 1u) {
            if (stk[src + i] <= cur) { cnt = cnt + 1u; }
          }
          v = f32(cnt) / f32(t - lo + 1u);
        }
        else {
          // MA/STD/ZSCORE/DEMEAN 族
          let lo = select(0u, t - w + 1u, t + 1u >= w);
          var s1 = 0.0; var s2 = 0.0;
          for (var i = lo; i <= t; i = i + 1u) {
            let x = stk[src + i];
            s1 = s1 + x; s2 = s2 + x * x;
          }
          let c = f32(t - lo + 1u);
          let m = s1 / c;
          let sd = sqrt(max(s2 / c - m * m, 0.0));
          if (op == OP_MA5 || op == OP_MA10 || op == OP_MA20 || op == OP_MA60) { v = m; }
          else if (op == OP_STD10 || op == OP_STD20 || op == OP_STD60) { v = sd; }
          else if (op == OP_DMN20) { v = stk[src + t] - m; }
          else { v = (stk[src + t] - m) / max(sd, 1e-8); }
        }
        stk[dst + t] = sane(v);
      }
      if (!elemwise) {
        storageBarrier();
        for (var t = lid; t < T; t = t + W) { stk[src + t] = stk[tmp + t]; }
      }
      storageBarrier();
    }
  }

  if (sp != 1u) { fail = true; }

  if (fail) {
    if (lid == 0u) { stats[p * 2u + 1u] = -1.0; }
    return;
  }

  // 顶层(sp-1=0)→ 因果滚动归一化(P0-2 口径,与 vm.py 同源:窗 250,
  // 头部部分窗口)后写 factorOut;逐线程各自回看窗口,无需跨线程同步
  let top = stkBase;
  for (var t = lid; t < T; t = t + W) {
    let lo = select(0u, t - 249u, t >= 249u);
    var s1 = 0.0; var s2 = 0.0;
    for (var i = lo; i <= t; i = i + 1u) {
      let x = stk[top + i];
      s1 = s1 + x; s2 = s2 + x * x;
    }
    let c = f32(t - lo + 1u);
    let m = s1 / c;
    let sd = sqrt(max(s2 / c - m * m, 0.0));
    factorOut[p * T + t] = clamp((stk[top + t] - m) / max(sd, 1e-8), -3.0, 3.0);
  }
  storageBarrier();

  // 全样本 std 归约:仅用于近常数判定(std<1e-6 → 无效候选)
  var ps = 0.0;
  var psq = 0.0;
  for (var t = lid; t < T; t = t + W) {
    let x = factorOut[p * T + t];
    ps = ps + x; psq = psq + x * x;
  }
  redA[lid] = ps;
  redB[lid] = psq;
  workgroupBarrier();
  var s: u32 = W / 2u;
  loop {
    if (s == 0u) { break; }
    if (lid < s) { redA[lid] = redA[lid] + redA[lid + s]; redB[lid] = redB[lid] + redB[lid + s]; }
    workgroupBarrier();
    s = s >> 1u;
  }
  if (lid == 0u) {
    let mean = redA[0] / f32(T);
    stats[p * 2u] = mean;
    stats[p * 2u + 1u] = sqrt(max(redB[0] / f32(T) - mean * mean, 0.0));
  }
}

// 注:factorOut 已是归一化值(P0-2),evalMetrics 的 zAt 不再二次归一
// ——stats 仅提供常数判定。

// ── Pass B:单线程指标(f32 + Kahan;与 evaluate.py 同式)────────

struct Acc { s: f32, c: f32 }

fn kadd(acc: ptr<function, Acc>, v: f32) {
  let y = v - (*acc).c;
  let t = (*acc).s + y;
  (*acc).c = (t - (*acc).s) - y;
  (*acc).s = t;
}

fn posOf(z: f32) -> f32 {
  let p = tanh(clamp(z, -3.0, 3.0));
  return select(0.0, p, abs(p) >= 0.05);
}

fn zAt(p: u32, T: u32, t: u32) -> f32 {
  // P0-2:Pass A 已做因果滚动归一化并 clip ±3,此处直接取值
  return factorOut[p * T + t];
}

/** [lo,hi) 区间 sortino(evaluate.py _sortino 同式;prev 取区间前一 bar 的仓位) */
fn sortinoRange(p: u32, T: u32, lo: u32, hi: u32, cost: f32, periods: f32) -> f32 {
  if (hi - lo < 2u) { return 0.0; }
  var s = Acc(0.0, 0.0);
  var sdn = Acc(0.0, 0.0);
  var ndn: u32 = 0u;
  var prev = 0.0;
  if (lo > 0u) { prev = posOf(zAt(p, T, lo - 1u)); }
  for (var t = lo; t < hi; t = t + 1u) {
    let pos = posOf(zAt(p, T, t));
    let pnl = pos * ret[t] - abs(pos - prev) * cost;
    kadd(&s, pnl);
    if (pnl < 0.0) { kadd(&sdn, pnl * pnl); ndn = ndn + 1u; }
    prev = pos;
  }
  let n = f32(hi - lo);
  let mean = s.s / n;
  if (ndn == 0u) { return select(0.0, 20.0, mean > 0.0); }
  let dstd = sqrt(sdn.s / f32(ndn));
  if (dstd < 1e-9) { return 0.0; }
  return clamp(mean / dstd * sqrt(periods), -20.0, 20.0);
}

@compute @workgroup_size(64)
fn evalMetrics(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= params.P) { return; }
  let T = params.T;
  let cost = params.cost;
  let periods = params.periods;
  let std0 = stats[p * 2u + 1u];
  let base = p * 9u;

  // 失败(Pass A 判非法)或近常数(std<1e-6):无效候选
  if (std0 < 0.0 || std0 < 1e-6) {
    for (var i: u32 = 0u; i < 9u; i = i + 1u) { metrics[base + i] = 0.0; }
    metrics[base + 8u] = -999.0;
    return;
  }

  var sPnl = Acc(0.0, 0.0);
  var sTo = Acc(0.0, 0.0);
  var cum = 0.0;
  var peak = 0.0; // P2-19:回撤基线含 0 起点
  var maxdd = 0.0;
  var nLong: u32 = 0u;
  var nShort: u32 = 0u;
  var icx = Acc(0.0, 0.0);
  var icy = Acc(0.0, 0.0);
  var icxx = Acc(0.0, 0.0);
  var icyy = Acc(0.0, 0.0);
  var icxy = Acc(0.0, 0.0);
  let nIc = T - 1u;

  var prev: f32 = 0.0;
  for (var t: u32 = 0u; t < T; t = t + 1u) {
    let z = zAt(p, T, t);
    let pos = posOf(z);
    if (pos > 0.0) { nLong = nLong + 1u; } else if (pos < 0.0) { nShort = nShort + 1u; }
    let to = abs(pos - prev);
    kadd(&sTo, to);
    let pnl = pos * ret[t] - to * cost;
    kadd(&sPnl, pnl);
    cum = cum + pnl;
    if (cum > peak) { peak = cum; }
    let dd = peak - cum;
    if (dd > maxdd) { maxdd = dd; }
    if (t < nIc) {
      // P0-3 已修复口径:factor[t] ↔ ret[t](ret 本就是 t→t+1 前向收益)
      let y = ret[t];
      kadd(&icx, z); kadd(&icy, y);
      kadd(&icxx, z * z); kadd(&icyy, y * y); kadd(&icxy, z * y);
    }
    prev = pos;
  }

  let n = f32(T);
  let meanPnl = sPnl.s / n;
  let ann = meanPnl * periods;
  let sor = sortinoRange(p, T, 0u, T, cost, periods);

  // calmar(P2-19 已修复口径:回撤基线含 0 起点)
  var cal: f32;
  if (maxdd < 1e-9) { cal = select(0.0, 10.0, cum > 0.0); }
  else { cal = clamp(ann / maxdd, -10.0, 10.0); }

  // ts_ic(现状错位口径)
  var ic: f32 = 0.0;
  if (nIc >= 10u) {
    let m = f32(nIc);
    let mx = icx.s / m;
    let my = icy.s / m;
    let sx = sqrt(max(icxx.s / m - mx * mx, 0.0));
    let sy = sqrt(max(icyy.s / m - my * my, 0.0));
    if (sx >= 1e-6 && sy >= 1e-6) { ic = (icxy.s / m - mx * my) / (sx * sy); }
  }

  // 对称性 / 换手质量
  let dev = abs(f32(nLong) / n - 0.5) + abs(f32(nShort) / n - 0.5);
  let sym = max(-1.0, 1.0 - 2.0 * dev);
  let toMean = sTo.s / n;
  var tq: f32;
  if (toMean < 1e-6) { tq = -1.0; }
  else if (toMean <= 1.0) { tq = 0.0; }
  else { tq = max(-1.0, -(toMean - 1.0)); }

  // OOS 门控:后 25%;半段一致性
  let oosN = max(1u, T / 4u);
  let oosSor = sortinoRange(p, T, T - oosN, T, cost, periods);
  let half = T / 2u;
  let s1 = select(0.0, sortinoRange(p, T, 0u, half, cost, periods), half > 1u);
  let s2 = select(0.0, sortinoRange(p, T, half, T, cost, periods), T - half > 1u);
  var consist: f32;
  if (s1 > 0.0 && s2 > 0.0) { consist = 0.5; }
  else if (s1 * s2 < 0.0) { consist = -1.0; }
  else { consist = 0.0; }
  let oosMult = select(min(1.2, 1.0 + oosSor * 0.1), 0.0, oosSor <= 0.0);

  let annTerm = clamp(ann, -1.0, 1.0);
  // OOS 硬淘汰:负样本外 → ×0 零平台(P1-4 经拍板不采纳,两端一致)
  let composite = (0.30 * annTerm + 0.15 * sor + 0.10 * cal + 0.20 * ic
    + 0.05 * sym + 0.05 * tq + 0.10 * consist) * oosMult;

  metrics[base + 0u] = ann;
  metrics[base + 1u] = sor;
  metrics[base + 2u] = cal;
  metrics[base + 3u] = ic;
  metrics[base + 4u] = sym;
  metrics[base + 5u] = tq;
  metrics[base + 6u] = oosSor;
  metrics[base + 7u] = consist;
  metrics[base + 8u] = composite;
}
`
