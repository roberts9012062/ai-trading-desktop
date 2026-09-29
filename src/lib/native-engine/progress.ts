const stages: Record<string, string> = { load_bars: "装载冻结行情快照…", mine_features: "GPU 计算训练特征…",
  eval_shards: "GPU 评估候选…", strict_eval: "GPU 执行严格筛与样本外验证…", precise: "GPU f64 精算与冠军验收…",
  dispose_session: "释放原生计算会话…" }
export const nativeStageLabel = (message: string) => stages[message] ?? message
const reasons: Record<string, string> = { strict_screen_failed_or_unproven: "严格筛未通过或证据缺失",
  research_only_candidate: "仅研究候选", insufficient_samples: "样本不足", nonfinite_metric: "指标无效",
  oos_validation_unavailable: "无独立样本外验证", oos_validation_failed_or_missing: "样本外验证未通过",
  live_fill_failed_or_missing: "实盘成交口径未通过", execution_failed_or_missing: "执行模型验证未通过",
  wf_failed_or_missing: "Walk-forward 未通过", wf_oos_evidence_missing: "Walk-forward 独立样本外折证据缺失",
  wf_oos_fold_failed: "Walk-forward 样本外折未通过", holdout_failed_or_missing: "封存区未通过",
  holdout_stress_failed_or_missing: "封存区成本压力测试未通过", holdout_live_entry_failed: "封存区开仓口径未通过",
  holdout_sealed: "等待最终代封存揭示" }
export const qualificationReasonLabel = (code: string) => reasons[code] ?? code
