# 短线因子实验室零冠军根因分析

日期：2026-10-01  
症状：短线因子实验室（1m/5m/15m）找不到任何合格冠军因子

## 核心问题

### 问题 1：归一化窗口不匹配（主因）

**设计 vs 实现**

| 位置 | 窗口定义 | 1m | 5m | 15m |
|------|---------|----|----|-----|
| `src/lib/shortline/spec.ts:53` | `SHORTLINE_ZSCORE_WINDOW = 300` | 300 | 300 | 300 |
| `public/pykernel/factor_lab/research_context.py:63` | `norm_window_for_bars()` | **1440** | **288** | **96** |
| `public/pykernel/factor_lab/scoring/walk_forward.py:46` | `WARMUP_BARS` | 250 | 250 | 250 |

**计算逻辑**：
```python
# research_context.py:91
gap = sorted(gaps)[len(gaps) // 2]  # bar间距（秒）
per_day = 86400.0 / gap              # 每天bar数
return max(_V2_BASE_WINDOW, int(per_day + 0.999999))
```

- **1m**：`86400 / 60 = 1440` bars/天 → 窗口 1440（**错误：应为 300**）
- **5m**：`86400 / 300 = 288` bars/天 → 窗口 288（接近但仍非固定 300）
- **15m**：`86400 / 900 = 96` bars/天 → 回落 200（**错误：应为 300**）

**影响**：

1. **训练与验证窗口不一致**：
   - 训练时用动态窗口（1m=1440, 15m=200）
   - 验证折用固定 250 窗口
   - **导致同一公式在不同阶段归一化基线不同，第二折被误判为负收益**

2. **前缀不变性破坏**：
   - 设计文档 E2 证据：`[2.74252, 0.64372, 13.74880]` vs `[3.19501, -0.66639, 20.00000]`
   - 第二折从 +0.64 变成 -0.67，符号反转

3. **特征有效性降低**：
   - 1m 窗口 1440 远超短线因子的有效周期（300）
   - 过度平滑，丢失短期信号

### 问题 2：shortline_v1 错误归入 crypto_local_v2 语义族

**代码路径**：
```python
# public/pykernel/factor_lab/research_context.py:54-56
def is_v2_family(profile: str) -> bool:
    return profile in (PROFILE_CRYPTO_LOCAL_V2, PROFILE_SHORTLINE_V1)
```

**错误**：`shortline_v1` 被标记为 v2 语义族成员，自动继承了动态归一化窗口逻辑，而非使用固定 300 窗口。

**正确逻辑**：
- `crypto_local_v2` 应使用动态窗口（适配多周期）
- `shortline_v1` 应使用固定 300 窗口（短线特定）

### 问题 3：样本不足拦截

**v2 正式研究门槛**（`factor_lab/scoring/split_plan.py`）：
- 训练 ≥ 500 bars
- 验证/封存各 ≥ 120 bars
- 验证/封存各 ≥ 30 自然天

**1m 数据现状**：
- 低内存档：60 天 × 1440 bars/天 = 86400 bars
  - 训练（60%）：51840 bars ✓
  - 验证（20%）：17280 bars ✓
  - 封存（20%）：17280 bars ✓
  - **但自然天数**：验证 12 天、封存 12 天 ✗（< 30天）

**结果**：被标记为 `exploratory`（仅探索），不颁发合格资格。

### 问题 4：verification 与 holdout 评估缺失

**设计文档 E7**：
> 因子实验室旧入口可能落入 legacy：1826根日线、0.7训练、3折、增强切封存后，
> 训练1278/可见1552，独立OOS折为0。

**原因**：
- `shortline_v1` 虽然声明为 v2 语义族
- 但验证/封存逻辑可能未完整接入
- 导致最终代验证折数为 0，无法通过严格筛

## 设计文档证据索引

| 编号 | 证据 | 文件位置 |
|-----|------|---------|
| E1 | "正常 v2 小时线输出归一化窗口为200；Python默认250，折内仅取250根历史重算" | `docs/plans/2026-09-30-factor-mining-reliability-design.md:30` |
| E2 | "连续计算三折Sortino约 [2.74252, 0.64372, 13.74880]；当前WF约 [3.19501, -0.66639, 20.00000]" | 同上:31 |
| E4 | "v2验证和封存各要求至少30自然天；低/中内存档1m默认最多60/120天" | 同上:33 |
| E7 | "因子实验室旧入口可能落入legacy：...独立OOS折为0" | 同上:36 |

## 修复方案

### 立即修复（阻断性）

1. **为 shortline_v1 固定归一化窗口为 300**

```python
# public/pykernel/factor_lab/research_context.py
def resolve_context(...) -> ResearchContext | None:
    ...
    if profile == PROFILE_SHORTLINE_V1:
        norm_window = 300  # 短线固定窗口
    else:
        norm_window = norm_window_for_bars(bars)  # v2 动态窗口
    
    return ResearchContext(
        ...
        norm_window=norm_window,
        ...
    )
```

2. **walk_forward 使用上下文窗口**

```python
# public/pykernel/factor_lab/scoring/walk_forward.py
def walk_forward_eval(..., context: ResearchContext | None = None):
    w = context.norm_window if context else WARMUP_BARS
    # 替代所有 WARMUP_BARS 的硬编码
```

3. **降低 1m 样本门槛或延长回填区间**
   - 方案 A：将 1m 建议回填区间从 30 天提升到 90 天
   - 方案 B：为 shortline_v1 单独设置验证/封存门槛（各 15 天）

### 验证步骤

1. 使用 `scripts/factor-verify-run.py` 复现 E2 案例：
```bash
python scripts/factor-verify-run.py \
  --symbol BTCUSDT --tf 1h \
  --population 100 --generations 5
```

2. 检查输出中 `norm_window` 是否为 300（修复后）

3. 验证三折 Sortino 符号一致性

## 下一步

1. 实施上述立即修复
2. 按设计文档 2026-09-30 方案 A 分阶段落实 v3 研究契约
3. 补全短线黄金夹具测试（`shortline-golden-fixture-*.json`）
