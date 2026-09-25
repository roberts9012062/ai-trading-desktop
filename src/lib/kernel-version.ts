/**
 * 当前内核口径版本 —— 与 public/pykernel/factor_local.py 的 kernel_version() 保持同步。
 *
 * 用途(发布前清单第 2/7 步):历史/收藏记录的 metrics.kernel_version 与此
 * 不一致(或缺戳)即视为「旧内核口径产出」——UI 提示口径已变更,并禁止从
 * 该类记录直接挂载实盘。内核升版时必须同步改这里(内核侧有
 * verify-kernel-tests 守卫,此处靠走查)。
 */
export const CURRENT_KERNEL_VERSION = "pykernel-factor-2026-09-25.5"
