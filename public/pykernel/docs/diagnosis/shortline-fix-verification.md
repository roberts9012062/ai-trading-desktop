# 短线因子归一化窗口修复验证

日期：2026-10-01  
修复版本：R1 立即修复补丁

## 修复内容

### 1. Python 内核：固定 shortline_v1 归一化窗口为 300

**文件**：`public/pykernel/factor_lab/research_context.py`

**变更 1**：新增常量定义
```python
# 行 28-29（新增）
SHORTLINE_NORM_WINDOW = 300
```

**变更 2**：resolve_context 使用固定窗口
```python
# 行 149-160（修改）
# 短线固定归一化窗口 300;crypto_local_v2 动态推导
if profile == PROFILE_SHORTLINE_V1:
    norm_window = SHORTLINE_NORM_WINDOW
    warmup = SHORTLINE_NORM_WINDOW
else:
    norm_window = norm_window_for_bars(bars)
    warmup = int(payload.get("warmup") or 250)

split = build_split_plan(
    len(bars),
    label_span=label_span,
    warmup=warmup,
    bars=bars,
)
```

### 2. Python 搜索：传递归一化窗口到验证折

**文件**：`public/pykernel/factor_lab/search.py`

**变更 1**：_strict_gate 调用（行 954-956）
```python
wf = walk_forward_eval_v2(
    tokens, all_bars, timeframe, cost, plan, walk_forward_folds,
    norm_window=ctx.norm_window if ctx else 250,  # 新增参数
)
```

**变更 2**：_dedup_top 调用（行 1225-1227）
```python
wf = walk_forward_eval_v2(
    tokens, all_bars, timeframe, cost, plan, walk_forward_folds,
    norm_window=ctx.norm_window if ctx else 250,  # 新增参数
)
```

## 验证步骤

### 步骤 1：单元测试（Python 常量）

```bash
cd public/pykernel
python -c "
from factor_lab.research_context import SHORTLINE_NORM_WINDOW, PROFILE_SHORTLINE_V1
assert SHORTLINE_NORM_WINDOW == 300, 'shortline窗口应为300'
assert PROFILE_SHORTLINE_V1 == 'shortline_v1', 'profile名称错误'
print('✓ 常量定义正确')
"
```

### 步骤 2：集成测试（归一化窗口推导）

```bash
cd public/pykernel
python -c "
import json
from factor_lab.research_context import resolve_context

# 模拟 1m bars
bars = [{'time': f'2024-01-01T00:{str(i).zfill(2)}:00', 'close': 100.0} for i in range(1500)]

# shortline_v1 应使用固定 300
payload_shortline = {
    'research_profile': 'shortline_v1',
    'timeframe': '1m',
    'symbol': 'BTCUSDT',
}
ctx = resolve_context(payload_shortline, bars, 0.0003)
assert ctx.norm_window == 300, f'shortline_v1 窗口应为300，实际 {ctx.norm_window}'
print(f'✓ shortline_v1 归一化窗口 = {ctx.norm_window}')

# crypto_local_v2 应使用动态窗口
payload_v2 = {
    'research_profile': 'crypto_local_v2',
    'timeframe': '1m',
    'symbol': 'BTCUSDT',
}
ctx2 = resolve_context(payload_v2, bars, 0.0003)
print(f'✓ crypto_local_v2 归一化窗口 = {ctx2.norm_window} (动态推导)')
"
```

### 步骤 3：端到端测试（复现 E2 案例）

```bash
# 使用验证脚本复现 GATE-BTC_USDT-1h PV_CORR 案例
python scripts/factor-verify-run.py \
  --symbol BTCUSDT --tf 1h \
  --population 100 --generations 10 \
  --out /tmp/verify-fix.json

# 检查输出
python -c "
import json
result = json.loads(open('/tmp/verify-fix.json').read())
print(f'合格数: {result[\"qualified\"]}/{result[\"champions_total\"]}')
if result['qualified'] > 0:
    print('✓ 修复成功：找到合格冠军')
else:
    print(f'拒因分布: {result[\"reasons\"]}')
"
```

### 步骤 4：回归测试（确保不破坏旧版本）

```bash
# crypto_local_v2 应继续使用动态窗口
cd public/pykernel
python -c "
import json
from factor_local import run

# 15m bars (应推导窗口 96 → 回落 200)
bars = [{'time': f'2024-01-01T{str(i//4).zfill(2)}:{15*(i%4):02d}:00', 'close': 100.0} 
        for i in range(500)]

payload = json.dumps({
    'mode': 'research_context',
    'research_profile': 'crypto_local_v2',
    'timeframe': '15m',
    'symbol': 'ETHUSDT',
})
result = json.loads(run(payload, json.dumps(bars)))
print(f'crypto_local_v2 15m 窗口 = {result[\"norm_window\"]} (应为200)')
assert result['norm_window'] == 200, 'v2动态窗口回归失败'
print('✓ crypto_local_v2 回归测试通过')
"
```

## 预期修复效果

### 修复前（2026-09-30 状态）

| 周期 | 训练窗口 | 验证窗口 | 一致性 | 结果 |
|-----|---------|---------|--------|------|
| 1m | **1440** | 250 | ✗ | 第二折符号反转 |
| 5m | **288** | 250 | ✗ | 数值漂移 |
| 15m | **96→200** | 250 | ✗ | 窗口不匹配 |

### 修复后（预期）

| 周期 | 训练窗口 | 验证窗口 | 一致性 | 结果 |
|-----|---------|---------|--------|------|
| 1m | **300** | **300** | ✓ | 数值一致 |
| 5m | **300** | **300** | ✓ | 数值一致 |
| 15m | **300** | **300** | ✓ | 数值一致 |

### 量化指标

- **E2 案例修复**：PV_CORR 三折 Sortino 符号应一致
  - 修复前：`[3.19501, -0.66639, 20.00000]`（第二折负数）
  - 修复后：应为 `[2.74252, 0.64372, 13.74880]`（全正）

- **合格率提升**：预计从 0% 提升到 5-20%（取决于数据质量）

## 遗留问题

### 1. 样本不足问题（1m 低内存档）

**状态**：仍需解决

**原因**：1m 60天 → 验证/封存各 12 天 < 30天门槛

**临时方案**：
- 选项 A：提升 1m 建议回填区间到 90 天
- 选项 B：为 shortline_v1 单独降低日历门槛（各 15 天）

### 2. 设计文档方案 A 完整实施

**状态**：待交付

**内容**：
- R1：统一契约、无误筛、正确样本预检（**本次完成部分**）
- R2：训练内组合搜索、独立组合资格
- R3：固定快照消融、性能优化

参考：`docs/plans/2026-09-30-factor-mining-reliability-design.md`

## 后续步骤

1. 运行完整验证套件（步骤 1-4）
2. 使用真实短线任务验证（ETHUSDT 15m 建议优先）
3. 监控冠军数量与拒因分布变化
4. 根据结果决定是否调整样本门槛
5. 提交 PR 并更新版本号

## 版本号建议

- Pykernel: `+0.0.1`（bugfix 级别）
- 桌面应用: `0.2.53`（下一个 patch）
- Changelog: "fix(shortline): 修复归一化窗口不匹配导致零冠军问题"
