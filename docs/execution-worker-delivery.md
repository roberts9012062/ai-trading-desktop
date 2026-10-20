# 独立执行器分发

执行器在私有业务项目中编译，桌面公开项目只接收校验后的 Windows
原生分发目录。编译 C 文件、Python 源码、字节码、环境文件和运行数据库
不得加入桌面仓库或安装包。

## 私有构建

在私有项目安装 `backend/requirements-executor-build.txt` 后运行
`backend/.venv/Scripts/python.exe backend/scripts/build_executor.py --jobs 1`。
低并发避免当前构建机资源不足。仅在验证过编译器语言环境后，才能选择
`--compiler-cache`；`--reuse-build` 只接受私有 `.executor-build` 中的目录名。
当前构建工具固定为 Nuitka 4.3.1。构建器拒绝与锁定要求不同的版本；
内存受限的 Windows 构建任务使用 `--low-memory`。

构建器会锁定输出目录，比较编译前后的源码指纹，检查编译报告中的私有
模块类型，运行编译产物的 SQLite/加密/隔离自检，再生成逐文件清单。
只有 `.executor-build/distributions/` 下通过全部步骤的目录可以分发；
中间构建目录和诊断链接结果不能作为产物。

桌面项目执行 `node scripts/execution-worker.mjs --assemble COMPILED_DIRECTORY`
会验证完整文件清单、长度、摘要和路径，复制到暂存目录，再次校验后切换
到忽略入库的 `resources/execution-worker`。旧分发目录保留供回退。

## 固定二进制交付

压缩包只包含清单声明的文件和 `manifest.json`，文件位于压缩包根目录。
待当前产物通过原生启动测试后，将其作为桌面仓库的固定 Release 资产保存；
应用版本发布前可使用草稿 Release。资产标签使用 `executor-runtime-` 前缀，
不会匹配客户端的 `v*` 发布触发条件。

提交的 `execution-worker.lock.json` 必须包含以下六个字段：

| 字段 | 用途 |
| --- | --- |
| `protocol` | 当前为 `1` |
| `tag` | 固定的 `executor-runtime-...` 资产标签 |
| `asset` | 确切 ZIP 文件名，无路径和通配符 |
| `sha256` | 整个 ZIP 的 SHA-256 |
| `manifest_sha256` | 原始 `manifest.json` 字节的 SHA-256 |
| `build_id` | 必须与分发清单一致的构建编号 |

`node scripts/fetch-execution-worker.mjs` 只从
`roberts9012062/ai-trading-desktop` 获取上述固定资产，验证压缩包摘要，
在 `.local-data` 的新目录中限量解压，再验证清单摘要、构建编号和每个文件。
路径越界、链接、设备名、大小写冲突和清单外文件都会中止组装。
安装包中的清单也必须匹配提交的摘要，不能只相信可自行修改的文件清单。

CI 使用桌面仓库自身的 `GITHUB_TOKEN` 读取自己的资产；不需要、也不应
给公开工作流配置读取私有策略仓库的令牌。尚未生成并验证当前产物前，
不要填写虚假的锁定文件或触发客户端发布。

## 原生验收与退出

组装后执行
`cargo test --manifest-path src-tauri/Cargo.toml --lib compiled_distribution_self_test_and_rejected_bootstrap_use_native_process_contract -- --ignored`。
此检查会在不含本机 Python/venv 的环境中运行实际二进制自检，然后通过
Windows Job Object 和 stdin 协议传入无效准备数据，确认进程拒绝启动且
不创建数据库、不请求接口中心、不发出交易。

真实接管还需另外完成三端停机、套餐到期/撤销、未决交易、手动平仓和
新服务器任务版本的验收。二进制自检不表示这些生产验收已经完成。

打包脚本只能核对客户端已正常退出。它不能强杀持有交易租约或未决指令
的进程。用户正常退出、更新以及父进程意外退出分别经过检查点排空、
有界退出等待和 Windows Job Object 处理；缺少确认时保留待核对状态。
