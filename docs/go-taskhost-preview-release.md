# Go 托管客户端预览版打包

本轮版本 `0.2.215-go.2`，标签 `v0.2.215-go.2`，开发分支 `feat/go-taskhost-v0.1.0`。Go 后端版本 `0.1.0` 与桌面客户端版本独立编号。

`go.1` 候选打包在发布前取消。原生 HTTP 插件未将浏览器的 `redirect` 选项传入 Rust，请求现已同时设置 `maxRedirections: 0`，防止握手 Key 或凭证随重定向转发。保留原标签，不改写已推送的版本历史。

沿用 `.github/workflows/release.yml`：验证前端与原生资源 → 签名构建 → 校验更新器签名 → 临时 CI 用户下干净安装/升级/启动验收 → GitHub 预发布。

含预发布标识的标签通过 `scripts/publish-release.mjs` 发布为 prerelease，显式使用 `--latest=false`。预览版携带自己的 `latest.json` 以供核对，工作流跳过稳定 gist 更新，稳定版仍走原有清单收尾流程。推送标签前，四处版本（package.json、tauri.conf.json、Cargo.toml、Cargo.lock）必须一致。

当前默认页面为 Go 连接与任务托管开发入口，完整交易执行尚未交付。发布说明和界面均须保留这一状态，不能宣称暂存任务已开始执行，也不能将旧安装资源当作新的 Go 引擎。

签名私钥只通过既有 Actions Secret 提供；不上传本机 `证书`、`resources`、数据库或 `.env`。升级验收只在临时 CI 用户执行，不能为打包强制关闭用户正在运行的交易客户端。
