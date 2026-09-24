/**
 * 更新下载鉴权 token(占位符,构建时由 make-update.mjs 注入真实值)
 * 用途:updater 运行时请求头,下载 api.github.com 私有 Release 资产
 */
export const UPDATE_TOKEN = "__UPDATE_TOKEN__"
