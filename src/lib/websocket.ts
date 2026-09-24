/**
 * WebSocket 客户端 —— 自动连接/重连/心跳，解析消息类型并分发回调
 */

/**
 * 根据环境生成 WebSocket 基础 URL
 * - 优先 NEXT_PUBLIC_WS_URL（构建时注入生产 WebSocket 地址）
 * - 否则公网域名走 3051 反代，内网/开发主机直连 8002
 * - SSR/构建期 → 占位
 */
type WsLocation = Pick<Location, "protocol" | "hostname">

export function resolveWsBase(
  location: WsLocation | undefined,
  envWs = process.env.NEXT_PUBLIC_WS_URL,
): string {
  // 桌面端(Tauri):hostname 是 tauri.localhost,浏览器 hostname 判定不适用,
  // 改用 desktop-boot.ts 注入的基址直连服务器(优先级:用户 localStorage 覆盖 > 构建默认)
  if (typeof window !== "undefined" && window.__QH_WS_BASE__) {
    return window.__QH_WS_BASE__
  }
  // hostname 判定优先：测试环境(内网IP)连本地 backend:8002、生产公网(uusb.eu.org)连 3051 反代。
  // 不依赖构建时 NEXT_PUBLIC_WS_URL —— 曾因构建环境注入残留(uusb)导致测试环境误连公网入口,
  // 故浏览器侧一律按访问 hostname 判定；envWs 仅作 SSR/构建期无 location 时的兜底。
  if (location) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const port = location.hostname === "uusb.eu.org" ? 3051 : 8002
    return `${protocol}//${location.hostname}:${port}`
  }
  if (envWs && envWs.trim()) return envWs.replace(/\/$/, "")
  return "ws://localhost"
}

function getWsBase(): string {
  return resolveWsBase(typeof window === "undefined" ? undefined : window.location)
}

/** WebSocket 消息 */
export interface WsMessage {
  type: string
  data: unknown
}

/** 单条行情数据 */
export interface QuoteData {
  symbol: string
  name: string
  exchange: string
  last_price: number
  change: number
  change_pct: number
  open_price: number
  high_price: number
  low_price: number
  pre_close: number
  bid_price: number
  ask_price: number
  bid_vol: number
  ask_vol: number
  volume: number
  position: number
  tick_time: string
  decimal_places: number
  source?: string
  recv_ts?: number
  trade_date?: string
  simnow_stale?: boolean
  field_meta?: Record<string, { source: string; quality: string }>
}

/** 消息回调函数类型 */
export type MessageHandler = (message: WsMessage) => void

/** 连接状态 */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting"

/** 状态变更回调 */
export type StateHandler = (state: ConnectionState) => void

/** 连接成功回调（含首次与重连） */
export type OpenHandler = (info: { isReconnect: boolean }) => void

/** 重连配置 */
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]
const HEARTBEAT_INTERVAL = 30_000
/**
 * 连接静默上限：服务端交易时段秒级推送、休市也按渠道间隔推快照，
 * 长期收不到任何消息 = 连接已半开死亡（server→client 方向断，本端
 * readyState 仍 OPEN，发送不报错）。超时强制断开走重连，防「页面
 * 连接假活、行情/K 线永久冻结」（2026-08-26 K 线假死排查确认的隐患）。
 * 服务端 2.5s 推帧 + 心跳 30s，取 90s 有充足余量。
 */
const HEARTBEAT_STALE_MS = 90_000

/**
 * WebSocket 客户端类 —— 管理 WebSocket 连接生命周期
 */
export class MarketWebSocket {
  private ws: WebSocket | null = null
  private url: string
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private messageHandlers: Set<MessageHandler> = new Set()
  private stateHandlers: Set<StateHandler> = new Set()
  /** K 线订阅合约清单（服务端只推送订阅合约的 forming bar；null=全量） */
  private klineSubscription: string[] | null = null
  private openHandlers: Set<OpenHandler> = new Set()
  private _state: ConnectionState = "disconnected"
  private intentionalClose = false
  /** 是否已经成功连接过（用于区分首次 open 与重连 open） */
  private hasConnectedOnce = false
  /** 最近一次收到服务端消息的时刻（任意消息都算活跃，含 pong） */
  private lastMessageAt = 0

  constructor(path: string = "/ws/market") {
    this.url = `${getWsBase()}${path}`
  }

  /** 当前连接状态 */
  get state(): ConnectionState {
    return this._state
  }

  /** 连接 WebSocket */
  connect(): void {
    // OPEN / CONNECTING 直接返回，避免叠连
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.ws?.readyState === WebSocket.CONNECTING) return

    this.intentionalClose = false
    // 若存在残留 socket（CLOSING/CLOSED 引用），先拆掉再重建
    if (this.ws !== null) {
      this.detachSocket(false)
    }

    this.setState(this.hasConnectedOnce ? "reconnecting" : "connecting")

    try {
      // 每次 connect 从 localStorage 取最新 token（登录/刷新后生效）
      const token =
        typeof window !== "undefined" ? localStorage.getItem("access_token") : null
      if (!token) {
        // 无 token 不建立连接，避免服务端 4401 抖动；登录后由 initWebSocket 再调
        this.setState("disconnected")
        return
      }
      const url = `${this.url}?token=${encodeURIComponent(token)}`
      this.ws = new WebSocket(url)
      this.ws.onopen = this.handleOpen
      this.ws.onmessage = this.handleMessage
      this.ws.onclose = this.handleClose
      this.ws.onerror = this.handleError
    } catch {
      this.scheduleReconnect()
    }
  }

  /** 断开连接 */
  disconnect(): void {
    this.intentionalClose = true
    this.cleanup()
    this.setState("disconnected")
  }

  /** 注册消息回调 */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  /** 注册状态变更回调 */
  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }

  /** 注册 open 回调（重连回补用） */
  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler)
    return () => this.openHandlers.delete(handler)
  }

  // ========== 内部方法 ==========

  private setState(state: ConnectionState): void {
    this._state = state
    this.stateHandlers.forEach((handler) => handler(state))
  }

  private handleOpen = (): void => {
    const isReconnect = this.hasConnectedOnce
    this.reconnectAttempt = 0
    this.hasConnectedOnce = true
    this.lastMessageAt = Date.now()
    this.setState("connected")
    this.startHeartbeat()
    // 重连后服务端订阅状态归零，重发 K 线订阅
    this.sendKlineSubscription()
    this.openHandlers.forEach((handler) => handler({ isReconnect }))
  }

  /**
   * 设置 K 线订阅：服务端只推送订阅合约的 forming bar（省流量）。
   * 空数组/空参 = 恢复全量。连接未开时暂存，open 后自动发送。
   */
  setKlineSubscription(symbols: string[]): void {
    const list = Array.from(
      new Set(
        symbols
          .map((s) => String(s || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    )
    this.klineSubscription = list.length > 0 ? list : null
    this.sendKlineSubscription()
  }

  private sendKlineSubscription(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    // 未设置订阅时不发指令：新连接的服务端默认就是全量
    if (!this.klineSubscription) return
    this.ws.send(
      JSON.stringify({
        action: "subscribe_kline",
        symbols: this.klineSubscription,
      }),
    )
  }

  private handleMessage = (event: MessageEvent): void => {
    this.lastMessageAt = Date.now()
    try {
      // 服务端可能回 pong 纯文本，忽略（活跃时间已在上方刷新）
      if (typeof event.data === "string" && (event.data === "pong" || event.data === "ping")) {
        return
      }
      const message: WsMessage = JSON.parse(event.data as string)
      this.messageHandlers.forEach((handler) => handler(message))
    } catch {
      // 忽略非 JSON 消息
    }
  }

  private handleClose = (event: CloseEvent): void => {
    this.stopHeartbeat()
    this.ws = null
    // 鉴权失败：先尝试 refresh 拿新 access token，再重连；刷新失败才停
    // （会话标准 7 天，access 过期不应直接掐断行情）
    if (event.code === 4401) {
      if (this.intentionalClose) {
        this.setState("disconnected")
        return
      }
      void this.tryRefreshAndReconnect()
      return
    }
    if (!this.intentionalClose) {
      this.scheduleReconnect()
    }
  }

  /**
   * access token 过期时：调 refresh 接口换新 token 后重连 WebSocket
   * 刷新失败（refresh 也过期）→ 断开，由业务层引导重新登录
   */
  private async tryRefreshAndReconnect(): Promise<void> {
    this.setState("reconnecting")
    try {
      const { tryRefreshToken } = await import("@/lib/api")
      const ok = await tryRefreshToken()
      if (!ok) {
        this.setState("disconnected")
        return
      }
      // 新 token 已写入 localStorage，connect() 会重新读取
      this.reconnectAttempt = 0
      this.connect()
    } catch {
      this.setState("disconnected")
    }
  }

  private handleError = (): void => {
    // onclose 会在 onerror 之后触发，重连逻辑在 handleClose 中处理
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return
    if (this.reconnectTimer !== null) return

    this.setState("reconnecting")
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      // 静默超时：半开连接收不到任何消息但发送不报错，必须强制断开重连。
      // 不等 onclose——半开时 close 握手可能挂起数十秒；onclose 稍后触发
      // 时 reconnectTimer 已设，scheduleReconnect 幂等不会双连。
      if (Date.now() - this.lastMessageAt > HEARTBEAT_STALE_MS) {
        try {
          this.ws.close()
        } catch {
          /* ignore */
        }
        this.scheduleReconnect()
        return
      }
      // 与后端 receive_text 对齐：纯文本心跳即可（服务端回 pong）
      this.ws.send("ping")
    }, HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 拆掉当前 socket 监听（可选是否 close）
   * @param closeSocket 是否主动 close
   */
  private detachSocket(closeSocket: boolean): void {
    if (!this.ws) return
    this.ws.onopen = null
    this.ws.onmessage = null
    this.ws.onclose = null
    this.ws.onerror = null
    if (closeSocket && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
    }
    this.ws = null
  }

  private cleanup(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.detachSocket(true)
  }
}

/** 全局单例 */
let _instance: MarketWebSocket | null = null

/** 获取全局 WebSocket 实例 */
export function getMarketWebSocket(): MarketWebSocket {
  if (_instance === null) {
    _instance = new MarketWebSocket()
  }
  return _instance
}
