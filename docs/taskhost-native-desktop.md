# Go 原生托管桌面协议

桌面使用在线 `GET /api/v1/managed-capabilities`，只在 `protocol=taskhost-managed-v1`、`runtime_available=true`、`managed_tasks=true` 时允许新建。任务身份只从 `POST /managed-tasks` 的服务器响应读取。页面不生成任务 ID；随机 request_id 仅用于请求身份。

新建结果未知时，保留当前服务器/用户下的原 request_id，禁止再次 POST，刷新列表或调用 `GET /managed-task-requests/{request_id}` 核对。注册未知只调用既有任务的 `/reconcile`。控制采用 fresh center-state → 一个 control 请求 → fresh center-state，所有 CAS 版本保持十进制字符串。单机模式通过 DPAPI 保存的中心 Key 读取中心已有任务，不能创建或修改原策略；旧任务恢复仍要求原服务器签名。

模型与交易所输入通过已认证 HTTPS 请求在服务器加密保存。本机接管输入由 Rust 用当前 Windows 用户 DPAPI、中心身份 scope 与 account_id 作为 entropy 加密；不写浏览器持久化存储、命令行、日志或错误。

## 本机 Go 进程

独立 IPC `taskhost_go_worker` 接受 scope、accountId、action（save/status/start/stop），输入只含 exchange 与 models。start 必须携带最近 status 的 expectedGeneration。停止、更换凭证、断开连接和升级会使旧 generation 失效；退出/升级先设启动屏障再等待锁。升级失败只开放新的显式启动，旧请求仍被隔离。

Rust 固定应用数据目录：`taskhost-go/<SHA256(scope)>/<account_id>/inputs.bin`、`vault.db`，路径不含应用版本，升级保留输入和账本；页面不能提供任意路径。Go worker 与旧 execution-worker 资源、输入和数据完全独立。

进程无命令行参数；首行 stdin UTF-8 JSON：

```json
{"protocol":"taskhost-go-worker-v1","center_key":"<memory only>","exchange":{"api_key":"...","secret":"...","passphrase":"...","demo":true},"account_id":"<64hex>","database_path":"<Rust fixed absolute vault.db>","mode":"standalone","allow_trading":false,"models":[{"id":"<original recipe model UUID>","name":"...","kind":"openai","base_url":"https://provider.example/v1","model_id":"...","api_key":"..."}]}
```

不提供 owner_id/subject/center_user_id 或任务配置，真实身份、原任务签名和权限由 Go 向中心获取。allow_trading 默认 false；勾选明确接管后才传 true，中心仍独立检查租约、检查点与所有权。模型 kind 支持 openai/claude/jev，未配置模型的任务由 Go 阻塞。

后续停止首行：`{"protocol":"taskhost-go-worker-v1","command":"stop"}`，flush 后关闭 stdin，等待最多 90 秒。只有退出码 0 且收到 stopped/stopped 才报告退出确认。超时保持进程句柄并禁止新启动；不伪造已停止状态。应用退出、更新安装和中心 Key 更换使用同一退出流程。

stdout 只接收不超过 4096 字节的 JSONL，字段 protocol/event/state/account_id?/checkpoint_seq?/error_code?。event 为 ready/status/stopped/failed；state 为 starting/observing/waiting_owner/reconciling/running/paused/stopped/blocked/failed；error_code 为空或 bootstrap_invalid/center_unavailable/identity_changed/database_unavailable/existing_tasks_unavailable/runtime_blocked/shutdown_incomplete/internal_error。版本、账户和字符串计数校验失败会发出停止命令并保留失败观察；stderr 丢弃。ready 仅表示进程启动，不代表取得执行权。

## 打包

`taskhost-go-worker.lock.json` 固定公开发行资产的 URL、大小与 SHA-256。`scripts/fetch-taskhost-go-worker.mjs` 只接受公开桌面仓库的 `taskhost-go-runtime-X.Y.Z` release、固定 worker 资产名称，不使用 GitHub Token，也不下载私有源码。下载与运行前分别校验摘要。资源最终为 `resources/taskhost-go-worker/taskhost-go-worker.exe`；Linux 可使用对应无后缀文件。

当前固定 Go worker v0.2.0，来源提交 0e74e16a2116b731e8cc59cad99db490f8bf551f；Windows/Linux 资源摘要与该标签 CI 构建逐字节一致。启动和发行均复核固定大小和 SHA-256。不能将旧 Python/独立执行器填入此资源。发行还运行真实 Go 二进制的非法 bootstrap 拒绝测试，证明原生加载与协议相符且不联系交易接口。

## 迁移与维护操作

在线迁移接口仅接收中心任务、账户和本地凭证／模型记录选择，服务器自行读取完整事实。先建立真实进程见证、暂停原任务、由 taskhost_legacy_shutdown 核对同一中心 Key／账户并等待旧 child 真实退出，再重新 inspect 和 commit。原任务 ID 不变；unknown 只 GET migration-requests/{request_id} 或 reconcile，不重复 POST。未提交且被服务器明确拒绝的请求才解除本地锁。

worker 的维护 action 另有 prepare-delete、prepare-resume、confirm-flat，必须匹配最近原生 generation、scope 和 account。Rust 生成独立 request_id，经私有 stdin 发出；Go 的 command 回执绑定原 account/request_id，单独存储，不能充当 stopped 回执。维护不创建任务或派发交易。准备删除后仍保留真实元数据心跳，用户需另行 fresh CAS 删除；准备恢复不自动恢复任务。空仓恢复使用独立 manual lease、全部十类正向 clear read、中心解锁 ACK 和 Release 后复核，任务保持停止。

同一备用账户可配置多个模型，各模型使用任务列表显示的原 Go 模型记录 ID；未配置模型的对应任务明确阻止执行。保存时全套输入由 Rust DPAPI 加密，所有密码输入随后清空。登录身份变化会重建页面和私有输入表单。

打包入口 make-update.mjs 在接触签名密钥之前核对 Go worker pin、文件大小与 SHA-256；缺少固定资源则停止打包。资源必须来自已通过私有 Go 仓库 Windows/Linux 测试、Linux race、三平台 CGO=0 构建及原生协议验证的公开编译资产，不能复用旧独立执行器。
