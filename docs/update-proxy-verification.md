# 免费 GitHub 更新代理验收（2026-10-06）

默认依次使用 GH-Proxy、GHFast、GitHub 直连；用户自定义 HTTP 代理优先。检查失败、下载中断或签名验证失败均切换下一通道。备用清单必须与已选版本、签名及下载地址一致，才允许重试下载；不会自动安装。

| 通道 | 清单与安装包片段 | 完整安装包 | 默认池 |
| --- | --- | --- | --- |
| https://gh-proxy.com/ | 通过 | 68,984,387 字节，签名通过，约 8 秒 | 是 |
| https://ghfast.top/ | 通过 | 68,984,387 字节，签名通过，约 12 秒 | 是 |
| https://ghproxy.net/ | 通过 | 本轮尚未完成完整包校验 | 否 |
| https://ghproxy.cc/ | 证书过期 | 未通过 | 否 |
| https://ghproxy.cn/ | 返回非清单/非安装包内容 | 未通过 | 否 |
| https://gh.llkk.cc/ | 网络不可达 | 未通过 | 否 |
| https://github.moeyy.xyz/ | DNS 无法解析 | 未通过 | 否 |
| https://ghproxy.homeboyc.cn/ | HTTP 403 | 未通过 | 否 |

两次完整下载使用公开 v0.2.116 安装包，与应用内签名公钥校验一致，SHA-256 均为 `8b715f8a334bbb208eb690df4ff4c2bdaeec1894e68df26c93af7c45fb16b88b`。测速结果取决于测试时网络，通道不可用时客户端自动切换。

发布清单保留资产 API 链接兼容旧客户端；新客户端将其转换为对应版本的公开 Release URL，无需内嵌 GitHub token。正式下载仍由 Tauri 官方 updater 验证完整包签名，免费代理不会收到 GitHub 凭据。清单请求携带时间参数避免重复使用旧缓存。

代理站点提供的使用方式：[GH-Proxy](https://gh-proxy.com/)、[GHFast](https://ghfast.top/)、[GHProxy.net](https://ghproxy.net/)。测试脚本及详细结果保存在本机忽略目录 `.local-data`。
