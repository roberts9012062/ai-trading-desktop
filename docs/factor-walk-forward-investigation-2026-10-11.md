# SOL 日线因子挖掘排查与验证

本次排查以用户提供的原生 GPU / SOL / 默认 OKX 日线任务为依据。报告区间为 2022-04-03 至 2026-10-09，共 1651 根；用户原任务的搜索种子、种群、代数和公式未取得，因此以下实验是同区间独立复现，不冒充原任务重放。

## 行情检查

从生产服务器的 OKX 专用 `get_okx_candles` 入口取得 1651 根 SOL 永续日线，来源标记均为 `okx`。没有重复日期、缺失日期或非法 OHLCV。

独立下载 OKX 官方 2026-10-09 分钟归档，去重后 1440 根，按北京时间合成日线，结果与服务器日线完全匹配：开 108.50、高 112.04、低 105.61、收 109.64、基础币成交量 11045894.43。该检查仅验证这一日期的归档与 API 一致，不能代表全部历史和全部衍生字段。

归档地址：<https://static.okx.com/cdn/okex/traderecords/candlesticks/daily/20261009/SOL-USDT-SWAP-candlesticks-2026-10-09.zip>。

冻结 JSON 文件 SHA-256：`ac119e1d339ebba93701967f7ac844ffd0a79036af1223ead28a53b23b4fe0b3`。本地证据为 `.local-data/sol-okx-daily-1651.json`，不提交行情及用户数据。

桌面端目前新建 OKX 归档研究的起点限制为 2023-07-01；它与服务器 OKX API 的历史深度不同。旧任务的 2022 年起点不能因此被直接判为错误来源。

## 已复现的程序缺陷

`SplitPlan` 规定验证段至少 120 根、每个验证折至少 60 根。CPU `walk_forward_eval_v2` 和原生 GPU `walk_forward_eval` 的 v2 分支却再次用段级 120 根门槛检查单折。

1651 根按 60/20/20 切为训练 991、验证 330、封存 330。三折每折 110 根，切分器接受，但两个评估器均直接返回 `None`。原生资格门随后以 `wf_failed_or_missing` 和 `wf_oos_evidence_missing` 拒绝候选。增加搜索代数无法改变同一任务的这个结构性缺口。

修复让两个 v2 评估器使用现有 `MIN_FOLD_BARS` 常量。验证/封存段门槛、每折收益为正要求、成本压力及其他资格门均保持原规定。旧 legacy 评估分支仍使用原段级门槛。

## 独立真实挖掘

通过现有 `nativeQualificationRun` / `FactorLabSearchRunner` 前端入口和真实 CUDA sidecar 执行，未使用 CPU 降级。配置为 600 种群、30 代、最大深度 6、种子 42、三折、自动成本、`crypto_local_v2`、增强搜索与组合功能开启。修复前使用 Git HEAD 导出的独立旧内核，修复后使用工作区内核；行情字节及配置相同。

修复前完成搜索但合格为 0；最终日志首候选 WF 为 `null`，包含折证据缺失拒因。回捞的两因子组合封存年化约 -5.15%、Sortino -0.160、2 倍成本 Sortino -0.283；三折约 0.742 / -0.394 / 2.549，组合失败有真实亏损依据。

修复后同预算完成搜索，决赛候选 7 个，其中 2 个合格、5 个因封存收益/压力测试失败而拒绝；缺失 WF 证据拒因消失。合格单因子构成的组合通过，平均绝对相关性 0.035；封存等权年化 9.1324%、Sortino 0.4742、2 倍成本 Sortino 0.2585；验证三折 Sortino 为 2.6104 / 1.7479 / 3.7020。两次实验实际自动成本均为 0.0006。结果属于既有 `signal_research` / 静态成本、未计资金费率的研究口径，不是实盘收益承诺。

| 同一冻结行情与搜索预算 | 修复前 | 修复后 |
| --- | --- | --- |
| 合格单因子 | 0 | 2 |
| 组合通过 | 否 | 是 |
| 组合等权封存年化 | -5.1496% | 9.1324% |
| 组合等权封存 Sortino | -0.1596 | 0.4742 |
| 组合等权 2× Sortino | -0.2826 | 0.2585 |
| 组合验证三折 Sortino | 0.7418 / -0.3937 / 2.5494 | 2.6104 / 1.7479 / 3.7020 |

精简机器可读证据见 `docs/experiments/2026-10-11-sol-wf-comparison.json`；完整原生实验结果保存在本地 `.local-data/sol-wf-before.json` 与 `.local-data/sol-wf-after.json`。修复改变验证筛选后的入选池，因此两次最终成员不同；没有根据封存结果调搜索参数或继续追加预算。

额外 CPU 检查：同一真实行情、固定成本 0.0003、52 个基础特征分别作为公式，修复后 9 个具有三折均为正的 WF 报告；例如 token `[0]` 三折 Sortino 为 1.5612 / 1.5077 / 1.1661。token `[1]` 含负折，仍不通过。该检查只说明 WF 证据恢复，不等于这些公式满足全部资格门。

## 其他影响因素与范围

用户报告中的组合三折和封存收益均为负，修复折样本门槛不能使该组合自动合格；平均绝对相关性 0.81 也表明成员信号相似，增加成员数本身不能证明分散效果。

短线实验室复用 v2 家族评估器，因此同样修复每折 60–119 根的误拦截。另有独立的既存配置限制：1m 在低/中内存档最大区间仅 60/120 天，20% 验证/封存仅 12/24 天，无法满足各 30 天的正式研究条件。该限制与本次 SOL 日线问题不同；本次没有放宽日历门槛，也没有完成用户短线原任务的逐候选重放。

本次服务器业务源码没有改动。修复位于桌面 CPU/Pyodide 与原生 GPU 内核，随桌面安装包分发。

## 回归验证

新增回归覆盖 900 / 1197 / 1651 根日线的有效验证折、59 根折拒绝，以及 110 根折的 CUDA/CPU 数值一致性。旧代码先复现 CPU 三种长度失败和 GPU 110 根折失败，再实施修复。

相关验证命令：

```powershell
.local-data/native-engine-venv/Scripts/python.exe -m unittest discover -s tests/native_engine -p test_wf.py -v
.local-data/native-engine-venv/Scripts/python.exe -X utf8 scripts/verify-kernel-tests.py
pnpm exec vitest run src/lib/mining/backends/native-gpu-core.test.ts src/lib/mining/native-factor-lab-integration.test.ts src/lib/mining/crypto-profile.test.ts
pnpm typecheck
```

结果：WF 回归 6 项通过（含 CUDA），内核不变量 5 项通过，相关前端/真实 Python 集成测试 13 项通过，TypeScript 检查通过。

桌面发布版本：v0.2.174；原生引擎版本：`native-gpu-v1-m3.5-wf-folds`；CPU 内核版本：`pykernel-factor-2026-10-11.1`。已将无需 CUDA 的折长回归加入 GitHub Release 构建。升级后应新建研究任务，旧冻结任务不会自动重新挖掘。
