// Real WebGPU vs CPython f64. Start Vite first. No Pyodide CDN dependency.
// PLAYWRIGHT_MODULE may point to a bundled Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.GPU_TEST_URL || 'http://127.0.0.1:5174');
    const bars = await page.evaluate(async () => {
      const { makeBars } = await import('/scripts/gpu-diagnostics.ts');
      return makeBars(1200).map((b, i) => ({ ...b, open_interest: null,
        time: new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString() }));
    });
    const dir = mkdtempSync(join(tmpdir(), 'crypto-gpu-'));
    const barsPath = join(dir, 'bars.json'), cfgPath = join(dir, 'config.json'), candidatesPath = join(dir, 'candidates.json');
    writeFileSync(barsPath, JSON.stringify(bars));
    writeFileSync(cfgPath, JSON.stringify({ symbol: 'BTCUSDT', timeframe: '60m', crypto_profile: true,
      train_ratio: .7, cost: .001 }));
    function reference(candidates) {
      writeFileSync(candidatesPath, JSON.stringify(candidates));
      return JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-X', 'utf8', 'scripts/gpu-parity-ref.py',
        '--bars', barsPath, '--config', cfgPath, '--candidates', candidatesPath], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
    }
    const initial = reference([]);
    const candidates = await page.evaluate(async (ref) => {
      const { Rng, gpuOpSets, randomTreeGpuSafe, treeToTokens } = await import('/src/lib/mining/gpu/gp.ts');
      const rng = new Rng(99, [...ref.active_feature_ids, ...ref.active_feature_ids.filter(i => i >= 45)]);
      const { opOne, opTwo } = gpuOpSets(true);
      return [[45, 104], [45, 105], [45, 106], [45, 107],
        ...Array.from({ length: 500 }, () => treeToTokens(randomTreeGpuSafe(4, ref.matrix.length, opOne, opTwo, rng)))];
    }, initial);
    const ref = reference(candidates);
    const result = await page.evaluate(async ({ ref, candidates, bars }) => {
      const { acquireGpuDevice } = await import('/src/lib/mining/device.ts');
      const { createGpuEval, gpuEvalBatch, disposeGpuEval } = await import('/src/lib/mining/gpu/eval-gpu.ts');
      const { nextRet } = await import('/src/lib/mining/gpu/eval-core.ts');
      const device = await acquireGpuDevice(() => {});
      const setup = await createGpuEval(device, new Float32Array(ref.matrix.flat()),
        new Float32Array(nextRet(bars.slice(0, ref.train_len).map(b => b.close))),
        { F: ref.matrix.length, T: ref.train_len, periods: ref.periods, cost: ref.cost, population: candidates.length });
      try {
        const values = await gpuEvalBatch(setup, candidates);
        const repeat = await gpuEvalBatch(setup, candidates);
        const pairs = ref.entries.flatMap((e, i) => e.valid && !e.rejected && !e.constant ? [{
          cpu: e.composite, gpu: values[i * 9 + 8] - .02 * Math.max(0, candidates[i].length - 12), i,
        }] : []);
        const ranks = (key) => {
          const sorted = pairs.map((p, i) => ({ v: Math.round(p[key] * 1e6) / 1e6, i })).sort((a,b) => a.v - b.v);
          const r = [];
          for (let i = 0; i < sorted.length;) {
            let j = i + 1; while (j < sorted.length && sorted[j].v === sorted[i].v) j++;
            for (let k = i; k < j; k++) r[sorted[k].i] = (i+j-1)/2;
            i = j;
          }
          return r;
        };
        const a = ranks('cpu'), b = ranks('gpu'), mean = (pairs.length-1)/2;
        let xy=0, xx=0, yy=0;
        a.forEach((v,i) => {xy+=(v-mean)*(b[i]-mean); xx+=(v-mean)**2; yy+=(b[i]-mean)**2;});
        const correlation=xy/Math.sqrt(xx*yy);
        const top = (key,n) => [...pairs].sort((a,b)=>b[key]-a[key]).slice(0,n).map(p=>p.i);
        const gpuTop=new Set(top('gpu',30)), recall=top('cpu',10).filter(i=>gpuTop.has(i)).length;
        const metricNames = ['ann_ret','sortino','calmar','ts_ic','symmetry','turnover_q','oos_sortino','consistency'];
        const newOps = ref.entries.slice(0,4).map((e,i) => ({token:104+i, cpu:e.composite,gpu:values[i*9+8],
          maxMetricError: Math.max(...metricNames.map((name,k)=>Math.abs(e.metrics[name]-values[i*9+k]))) }));
        const deterministic=values.every((v,i)=>v===repeat[i]);
        const opsPass=newOps.every(p=>Math.abs(p.cpu-p.gpu)<1e-3 && p.maxMetricError<1e-3);
        return { adapter: device.adapterInfo, features: ref.matrix.length, active: ref.active_feature_ids.length,
          candidates: candidates.length, valid:pairs.length, correlation, recall, deterministic, newOps,
          outliers: [...pairs].sort((a,b)=>Math.abs(b.cpu-b.gpu)-Math.abs(a.cpu-a.gpu)).slice(0,8).map(p=>({...p,tokens:candidates[p.i]})),
          passed:pairs.length>=300 && correlation>=.98 && recall>=8 && deterministic && opsPass };
      } finally { disposeGpuEval(setup); device.destroy(); }
    }, { ref, candidates, bars });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode=1;
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
