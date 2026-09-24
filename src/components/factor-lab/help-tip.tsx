"use client"

/**
 * 因子实验室帮助提示 —— 悬停问号显示释义
 */

import { HelpCircle } from "lucide-react"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/** 指标与参数释义（面向终端用户） */
export const FACTOR_HELP: Record<string, string> = {
  population:
    "种群：每一代同时评估的候选因子公式数量。越大搜索面越广、耗时越长。新手建议 30；本地 GPU 引擎一批粗排吞吐极高，可放心开到数千甚至上万（超级因子页极限档 10000）。",
  generations:
    "代数：遗传算法迭代轮数。每代保留表现好的公式，再交叉/变异生成下一代。越大越易收敛，但更慢。新手建议 15；本地 GPU 长跑可开到数百。",
  timeframe:
    "K 线周期：决定用多细的行情来挖掘因子。日线更稳、噪声少；分钟线信号更密，也更容易过拟合。",
  symbol:
    "合约代码：选择要挖掘因子的品种。可从下拉选，也可直接输入如 rb2610、IF2509。",
  composite:
    "综合分：把年化、Sortino、Calmar、预测力(IC)、多空对称、换手质量等加权，再乘样本外(OOS)门控。越高越好，是排行主依据。",
  ann_ret:
    "年化收益：把回测区间内的平均收益按交易日年化。正值表示因子整体赚钱；不等于未来保证收益。",
  sortino:
    "Sortino（索提诺比率）：单位「下行风险」能换来多少收益。只惩罚亏损波动，不惩罚上涨波动。一般 >1 较好，>2 优秀。",
  calmar:
    "Calmar（卡玛比率）：年化收益 ÷ 最大回撤。衡量扛回撤的能力。>1 表示年化收益超过最大回撤；越高越好。",
  oos_sortino:
    "OOS Sortino（样本外索提诺）：用后 25% 历史数据单独算的 Sortino，检验是否过拟合。样本内好看、样本外崩了通常不可信；OOS 为正且接近样本内更稳。",
  oos:
    "OOS：Out-of-Sample（样本外）。用后 25% 数据验证，避免只在训练段「碰巧」好看的过拟合因子。",
  ts_ic:
    "ts_IC：因子值与下一根收益的时序相关系数。衡量「预测下一根涨跌」的能力。绝对值越大预测力越强。",
  turnover:
    "换手：仓位平均变动幅度。过高意味着频繁调仓、成本吃利润；过低可能几乎不交易。",
  exposure:
    "在场：有持仓（非空仓）的时间占比。过低说明因子多数时间观望；过高可能一直满仓。",
  champion:
    "Champion：本轮搜索综合分最高的一批因子。点击某一行可看资金曲线与详细指标。",
  formula:
    "公式：遗传规划拼出的因子表达式（特征 + 算子）。系统用它生成连续仓位 position=tanh(因子)。",
  train_ratio:
    "训练/测试切分：把历史数据按比例切成两段，搜索只在「训练段」进行，预留的「测试段」搜索时完全不可见，事后用来验证。防止因子「背答案」式过拟合。0=关闭。",
  test_recent_bars:
    "近期作测试：强制把最近 N 根 K 线作为测试段，专治「训练好看、近期失效」。设 60 约等于最近一个季度（日线）。0=关闭。优先级高于训练比例。",
  walk_forward_folds:
    "Walk-Forward 折数：把历史切成多段滚动验证，每个因子必须在「所有折」的测试段都为正才算稳健。折数越多越严格，能筛掉只会在某段行情赚钱的因子。0=关闭，建议 3。",
  train_metrics:
    "训练段指标：搜索时所见的训练段纯指标快照。供与测试段对比，差距越大越可能过拟合。",
  test_metrics:
    "测试段指标：搜索时未见的独立测试段表现。这是「真功夫」——训练好看但测试为负的因子会被直接淘汰，排不进排行榜。",
  test_ann_ret:
    "测试年化：独立测试段的年化收益。若此值为负，说明因子在搜索时未见的新数据上亏损，属于过拟合，已被系统淘汰。",
  test_sortino:
    "测试 Sortino：独立测试段的索提诺比率。这是判断因子能否在近期（如 2025-07-31 之后）继续有效的关键。",
  wf_stable:
    "Walk-Forward 稳健：所有滚动测试段都为正才标 true。false 表示因子至少在一段历史时点上亏损，过拟合风险高。",
  overfit_warning:
    "过拟合警告：训练段年化好但测试段为负/接近零，说明因子只是「背下了」历史，换段就会失效。此类因子已被系统从排行中剔除。",
  holdout_sortino:
    "封存 Sortino（增强挖掘）：测试段后半在遴选全程被封存，只在最终冠军上评估一次，是对「整批冠军平均表现」的无偏估计。单个因子的封存值受行情阶段影响很大（约 1 年数据），不宜单独用它挑因子。",
  dsr:
    "DSR（Deflated Sharpe）：扣除「试了几万次才挑出它」的选择偏差后，真实夏普>0 的概率。GP 候选高度相关，按总试验数折算偏保守；仅供参考，不参与筛选。",
}

type TipSide = "top" | "bottom"
type TipAlign = "center" | "start" | "end"

interface HelpTipProps {
  text: string
  side: TipSide
  align: TipAlign
  className: string
}

function tipPosition(side: TipSide, align: TipAlign): string {
  const vert = side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
  if (align === "start") return `${vert} left-0`
  if (align === "end") return `${vert} right-0`
  return `${vert} left-1/2 -translate-x-1/2`
}

/** 问号图标 + 悬停浮层释义 */
export function HelpTip(props: HelpTipProps): React.JSX.Element {
  const { text, side, align, className } = props
  return (
    <span
      className={cn(
        "relative inline-flex items-center align-middle group/help",
        className,
      )}
      tabIndex={0}
      aria-label={text}
    >
      <HelpCircle
        className="w-3 h-3 text-[var(--text-muted)] opacity-60 group-hover/help:opacity-100 group-focus-within/help:opacity-100 cursor-help shrink-0"
        aria-hidden
      />
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-[60] w-56 sm:w-64 rounded-md border border-[var(--border)]",
          "bg-[var(--bg-elevated,var(--bg-secondary))] px-2.5 py-2 text-[10px] leading-relaxed",
          "text-[var(--text-secondary)] shadow-lg whitespace-normal text-left font-normal normal-case tracking-normal",
          "opacity-0 invisible group-hover/help:opacity-100 group-hover/help:visible",
          "group-focus-within/help:opacity-100 group-focus-within/help:visible transition-opacity duration-150",
          tipPosition(side, align),
        )}
      >
        {text}
      </span>
    </span>
  )
}

interface LabelWithHelpProps {
  htmlFor: string
  label: string
  help: string
}

/** 表单标签 + 问号 */
export function LabelWithHelp(props: LabelWithHelpProps): React.JSX.Element {
  const { htmlFor, label, help } = props
  return (
    <div className="flex items-center gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      <HelpTip text={help} side="bottom" align="center" className="" />
    </div>
  )
}

interface MetricCardProps {
  label: string
  value: string
  up: boolean
  help: string
}

/** 指标卡片（含问号释义） */
export function MetricCard(props: MetricCardProps): React.JSX.Element {
  const { label, value, up, help } = props
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/50 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
        <span>{label}</span>
        <HelpTip text={help} side="top" align="center" className="" />
      </div>
      <div className={cn("font-num font-semibold", up ? "text-up" : "text-down")}>
        {value}
      </div>
    </div>
  )
}

/** 页面顶部使用说明 */
export function FactorLabGuide(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/80 px-3.5 py-3 text-[11px] text-[var(--text-secondary)] space-y-2">
      <div className="font-medium text-[var(--text-primary)] text-xs">怎么用</div>
      <ol className="list-decimal list-inside space-y-1 leading-relaxed">
        <li>选合约与 K 线周期（日线更稳；分钟线信号更密、也更易过拟合）。</li>
        <li>
          设置
          <span className="inline-flex items-center gap-0.5 mx-0.5">
            种群
            <HelpTip text={FACTOR_HELP.population} side="bottom" align="center" className="" />
          </span>
          与
          <span className="inline-flex items-center gap-0.5 mx-0.5">
            代数
            <HelpTip text={FACTOR_HELP.generations} side="bottom" align="center" className="" />
          </span>
          （默认即可；加大搜索更广但更慢）。
        </li>
        <li>点「开始搜索」：遗传规划自动组合特征与算子，按多目标评分筛出 Champion。</li>
        <li>在排行表点选因子，右侧看资金曲线与 Sortino / Calmar / OOS 等指标。</li>
        <li>满意可「创建为因子任务」，到 AI 交易页启动模拟或实盘。</li>
      </ol>
      <p className="text-[var(--text-muted)] leading-relaxed">
        判读提示：优先看
        <span className="inline-flex items-center gap-0.5 mx-0.5">
          OOS Sortino
          <HelpTip text={FACTOR_HELP.oos_sortino} side="top" align="center" className="" />
        </span>
        是否为正——样本外仍赚钱才更可信；样本内很高但 OOS 很差，多半是过拟合。
      </p>
    </div>
  )
}
