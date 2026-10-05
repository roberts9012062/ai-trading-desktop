/**
 * AI 任务图标清单 —— slug / 中文名 / 分组
 * 与 frontend/public/ai-icons/*.png 一一对应（55 枚）
 * 供 IconPicker 九宫格与 provider-avatar 匹配共用
 */

export type IconGroup = "common" | "us" | "cn" | "quant"

export interface IconEntry {
  slug: string
  name: string
  group: IconGroup
  src?: string
}

/** 全部可用图标（common = 高频常用，单独置顶） */
export const AI_ICONS: IconEntry[] = [
  // 常用（高频，置顶）
  { slug: "openai", name: "OpenAI / ChatGPT", group: "common" },
  { slug: "claude", name: "Anthropic Claude", group: "common" },
  { slug: "gemini", name: "Google Gemini", group: "common" },
  { slug: "deepseek", name: "DeepSeek", group: "common" },
  { slug: "qwen", name: "通义千问 Qwen", group: "common" },
  { slug: "kimi", name: "Kimi / 月之暗面", group: "common" },
  { slug: "doubao", name: "豆包 Doubao", group: "common" },
  { slug: "grok", name: "xAI Grok", group: "common" },

  // 美国
  { slug: "copilot", name: "Microsoft Copilot", group: "us" },
  { slug: "meta", name: "Meta AI", group: "us" },
  { slug: "perplexity", name: "Perplexity", group: "us" },
  { slug: "bedrock", name: "Amazon Bedrock", group: "us" },
  { slug: "aistudio", name: "Google AI Studio", group: "us" },
  { slug: "vertexai", name: "Google Vertex AI", group: "us" },
  { slug: "azureai", name: "Microsoft Azure AI", group: "us" },
  { slug: "openrouter", name: "OpenRouter", group: "us" },
  { slug: "together", name: "Together AI", group: "us" },
  { slug: "fireworks", name: "Fireworks AI", group: "us" },
  { slug: "groq", name: "Groq", group: "us" },
  { slug: "deepinfra", name: "DeepInfra", group: "us" },
  { slug: "replicate", name: "Replicate", group: "us" },
  { slug: "huggingface", name: "Hugging Face", group: "us" },
  { slug: "nvidia", name: "NVIDIA AI", group: "us" },
  { slug: "cloudflare", name: "Cloudflare Workers AI", group: "us" },
  { slug: "cerebras", name: "Cerebras", group: "us" },
  { slug: "poe", name: "Poe", group: "us" },
  { slug: "replit", name: "Replit AI", group: "us" },

  // 中国
  { slug: "bailian", name: "阿里云百炼", group: "cn" },
  { slug: "volcengine", name: "火山引擎", group: "cn" },
  { slug: "hunyuan", name: "腾讯混元", group: "cn" },
  { slug: "yuanbao", name: "腾讯元宝", group: "cn" },
  { slug: "moonshot", name: "月之暗面", group: "cn" },
  { slug: "zhipu", name: "智谱 AI", group: "cn" },
  { slug: "qingyan", name: "智谱清言", group: "cn" },
  { slug: "wenxin", name: "百度文心", group: "cn" },
  { slug: "baiducloud", name: "百度智能云", group: "cn" },
  { slug: "minimax", name: "MiniMax", group: "cn" },
  { slug: "baichuan", name: "百川智能", group: "cn" },
  { slug: "stepfun", name: "阶跃星辰", group: "cn" },
  { slug: "yi", name: "零一万物 Yi", group: "cn" },
  { slug: "zeroone", name: "零一万物 01.AI", group: "cn" },
  { slug: "huaweicloud", name: "华为云 AI", group: "cn" },
  { slug: "spark", name: "讯飞星火", group: "cn" },
  { slug: "iflytek", name: "讯飞开放平台", group: "cn" },
  { slug: "sensenova", name: "商汤日日新", group: "cn" },
  { slug: "skywork", name: "昆仑万维天工", group: "cn" },
  { slug: "siliconcloud", name: "硅基流动", group: "cn" },
  { slug: "modelscope", name: "魔搭 ModelScope", group: "cn" },
  { slug: "coze", name: "扣子 Coze", group: "cn" },
  { slug: "ai360", name: "360 智脑", group: "cn" },
  { slug: "ppio", name: "PPIO 派欧云", group: "cn" },
  { slug: "giteeai", name: "Gitee AI", group: "cn" },
  { slug: "longcat", name: "美团 LongCat", group: "cn" },

  // 量化 / 因子
  { slug: "quant", name: "量化", group: "quant" },
  { slug: "factor", name: "因子", group: "quant" },
  { slug: "strategy-n-breakout", name: "N 日突破", group: "quant", src: "/strategy-icons/n_breakout.svg" },
  { slug: "strategy-ma-cross", name: "双均线", group: "quant", src: "/strategy-icons/ma_cross.svg" },
  { slug: "strategy-macd-cross", name: "MACD 交叉", group: "quant", src: "/strategy-icons/macd_cross.svg" },
  { slug: "strategy-kdj-cross", name: "KDJ 交叉", group: "quant", src: "/strategy-icons/kdj_cross.svg" },
  { slug: "strategy-band-swing", name: "布林带波段", group: "quant", src: "/strategy-icons/band_swing.svg" },
  { slug: "strategy-swing-pivot", name: "枢轴波段", group: "quant", src: "/strategy-icons/swing_pivot.svg" },
  { slug: "strategy-swing-pivot-v2", name: "枢轴波段 V2", group: "quant", src: "/strategy-icons/swing_pivot_v2.svg" },
  { slug: "strategy-swing-pro", name: "专业波段", group: "quant", src: "/strategy-icons/swing_pro.svg" },
  { slug: "strategy-strength-entry", name: "强弱进场", group: "quant", src: "/strategy-icons/strength_entry.svg" },
  { slug: "strategy-strength-entry-v2", name: "强弱形态 V2", group: "quant", src: "/strategy-icons/strength_entry_v2.svg" },
  { slug: "strategy-factor", name: "因子公式", group: "quant", src: "/strategy-icons/factor.svg" },
  { slug: "strategy-shortline-factor", name: "短线因子", group: "quant", src: "/strategy-icons/shortline_factor.svg" },
]

/** slug → public 路径 */
export function iconSrc(slug: string): string {
  return AI_ICONS.find(entry => entry.slug === slug)?.src ?? `/ai-icons/${slug}.png`
}

/** 全部 slug 集合（校验用） */
export const AI_ICON_SLUGS: Set<string> = new Set(
  AI_ICONS.map((e) => e.slug),
)

/** 是否有效图标 slug */
export function isValidIconSlug(slug: string | null | undefined): boolean {
  return Boolean(slug) && AI_ICON_SLUGS.has(slug as string)
}
