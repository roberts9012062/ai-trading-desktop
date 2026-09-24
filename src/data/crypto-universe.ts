/**
 * 加密币种宇宙(内置) —— 超级因子挖掘/因子实验室的可挖掘币种清单
 *
 * 桌面端 K 线数据直连 Binance 现货公开数据域(data-api.binance.vision),
 * 可挖掘性只取决于「该币在 Binance 现货有 USDT 交易对且历史足够」——
 * 不再依赖后端 PG 的品种元数据(那是 qihuo 期货口径,DT 服务器为空)。
 *
 * 口径:code 为全站统一的小写规范符号(btcusdt,与合约树/AI 交易一致);
 * sector 供跨币种验证选取同板块伙伴;历史深浅按 Binance 现货上线时间排序,
 * 大盘在前。新币种直接往数组里加即可。
 */

export interface CryptoAsset {
  /** 规范符号(小写,任务/数据层/因子实验室统一口径) */
  code: string
  /** 中文名(下拉展示与搜索) */
  name: string
  /** 板块(跨币种验证的同板块伙伴分组) */
  sector: string
}

export const CRYPTO_SECTORS = [
  "价值存储",
  "公链",
  "Layer2",
  "支付",
  "DeFi",
  "Meme",
  "AI算力",
  "存储网络",
  "RWA",
] as const

export const CRYPTO_ASSETS: readonly CryptoAsset[] = [
  // 价值存储 / 大盘
  { code: "btcusdt", name: "比特币", sector: "价值存储" },
  { code: "ethusdt", name: "以太坊", sector: "价值存储" },
  // 公链
  { code: "solusdt", name: "Solana", sector: "公链" },
  { code: "bnbusdt", name: "币安币", sector: "公链" },
  { code: "adausdt", name: "艾达币", sector: "公链" },
  { code: "avaxusdt", name: "雪崩", sector: "公链" },
  { code: "dotusdt", name: "波卡", sector: "公链" },
  { code: "trxusdt", name: "波场", sector: "公链" },
  { code: "atomusdt", name: "Cosmos", sector: "公链" },
  { code: "nearusdt", name: "NEAR", sector: "公链" },
  { code: "etcusdt", name: "以太经典", sector: "公链" },
  { code: "tonusdt", name: "Toncoin", sector: "公链" },
  { code: "icpusdt", name: "互联网计算机", sector: "公链" },
  { code: "aptusdt", name: "Aptos", sector: "公链" },
  { code: "suiusdt", name: "Sui", sector: "公链" },
  { code: "seiusdt", name: "Sei", sector: "公链" },
  { code: "tiausdt", name: "Celestia", sector: "公链" },
  // Layer2
  { code: "arbusdt", name: "Arbitrum", sector: "Layer2" },
  { code: "opusdt", name: "Optimism", sector: "Layer2" },
  // 支付
  { code: "xrpusdt", name: "瑞波币", sector: "支付" },
  { code: "ltcusdt", name: "莱特币", sector: "支付" },
  { code: "bchusdt", name: "比特现金", sector: "支付" },
  { code: "xlmusdt", name: "恒星币", sector: "支付" },
  { code: "hbarusdt", name: "Hedera", sector: "支付" },
  // DeFi
  { code: "linkusdt", name: "Chainlink", sector: "DeFi" },
  { code: "uniusdt", name: "Uniswap", sector: "DeFi" },
  { code: "aaveusdt", name: "Aave", sector: "DeFi" },
  { code: "injusdt", name: "Injective", sector: "DeFi" },
  { code: "runeusdt", name: "THORChain", sector: "DeFi" },
  { code: "enausdt", name: "Ethena", sector: "DeFi" },
  { code: "jupusdt", name: "Jupiter", sector: "DeFi" },
  // Meme
  { code: "dogeusdt", name: "狗狗币", sector: "Meme" },
  { code: "shibusdt", name: "Shiba Inu", sector: "Meme" },
  { code: "pepusdt", name: "佩佩", sector: "Meme" },
  { code: "wifusdt", name: "dogwifhat", sector: "Meme" },
  // AI 算力
  { code: "fetusdt", name: "Fetch.ai", sector: "AI算力" },
  { code: "renderusdt", name: "Render", sector: "AI算力" },
  { code: "wldusdt", name: "Worldcoin", sector: "AI算力" },
  { code: "grtusdt", name: "The Graph", sector: "AI算力" },
  // 存储网络
  { code: "filusdt", name: "Filecoin", sector: "存储网络" },
  { code: "arusdt", name: "Arweave", sector: "存储网络" },
  // RWA
  { code: "ondousdt", name: "Ondo", sector: "RWA" },
]
