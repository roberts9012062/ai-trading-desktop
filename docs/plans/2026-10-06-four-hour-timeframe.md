# 4 小时周期

统一存储 `240m`，界面显示“4小时”，OKX/Binance/Gate 适配为 `4H`/`4h`/`4h`。

覆盖 K 线选择、历史 bundle、实时订阅与缺口补拉、倒计时、AI 与量化任务创建/编辑、双周期共振、因子实验室、超级因子、短线实验室、历史/多段回测、合成行情、AI 看盘与预测、筛选器及 AI 工具。

计算口径：240 分钟，14,400 秒，全天 6 根；加密因子年化 2,190 根。OKX 归档只聚合完整的 240 根分钟线，缺失组不补造。双周期策略从较短周期取数，按周期比例增加预热。历史单段回测上限 365 天；因子研究上限 1,825 天，仍受渠道实际发布日期与本机预算约束。短线沿用 180 天成交归档默认预算及原有评分规则。

现有任务不会自动改周期。旧专业波段任务仅保存 `htf_factor` 时保持原有最近周期换算，新的 4 小时配置显式保存 `htf_tf=240m`。多周期猎手维持既有内置周期组合。

验收：TypeScript 类型检查、Vite 构建；764 项 Vitest 通过、1 项 GPU 环境测试跳过；本地 Python 内核 2 项 4 小时测试、6 项量化回归通过；服务端 193 项相关回归通过。10 个实际生产组件页面在隔离 API 下选择 4 小时并检查浏览器异常，K 线注入两次实时更新。验收入口为 `scripts/four-hour-ui-preview.html`，只能在本机 5187 端口运行，拒绝写接口。

原生周期参考：
- OKX: https://app.okx.com/docs-v5/en/
- Binance: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
- Gate: https://www.gate.com/en-us/docs/developers/apiv4/

桌面发布 v0.2.116；服务端以当前提交更新 Docker，保留配置与回滚镜像。
