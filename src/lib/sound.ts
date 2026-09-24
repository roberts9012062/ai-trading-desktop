/**
 * 提示音播放工具
 *
 * 由 profile/alert-settings-panel 的"消息提示音"开关驱动，
 * WS 推送 notification 时调 playNotificationSound()。
 * Audio 实例懒加载复用，避免重复创建 DOM 开销。
 */

// 内存中保存最新通知开关，默认开启
let _notifySettings: { notify_sound_enabled: boolean } = {
  notify_sound_enabled: true,
}

/** 注入提示音设置（由布局层从 /api/users/me/notify-settings 拉取后调用） */
export function setNotifySoundSettings(
  s: { notify_sound_enabled: boolean },
): void {
  _notifySettings = s
}

/** 当前是否启用提示音 */
export function isNotifySoundEnabled(): boolean {
  return _notifySettings.notify_sound_enabled
}

/** 播放新消息提示音（开关关闭时静默；播放异常静默吞掉，避免阻塞 UI） */
export function playNotificationSound(): void {
  if (!_notifySettings.notify_sound_enabled) return
  try {
    void new Audio("/sounds/notification.wav").play()
  } catch {
    // 自动播放策略限制 / Audio 构造失败：忽略
  }
}
