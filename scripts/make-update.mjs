/**
 * 生成自动更新产物:签名构建 → update-dist/(latest.json + 安装包 + 签名)
 *
 * 本地用法:
 *   node scripts/make-update.mjs "更新说明"
 * CI(GitHub Actions release.yml):secrets 提供 TAURI_SIGNING_PRIVATE_KEY。
 *
 * 更新分发:公开 GitHub Releases，永久清单由 gist 提供。
 * 客户端使用免费反向代理池或自定义 HTTP 代理，不内嵌下载凭据。
 * 发版流程:改 tauri.conf.json 的 version → commit → 打 tag v{version} → push。
 */
import { execSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const confPath = join(root, "src-tauri/tauri.conf.json")
const confOriginal = readFileSync(confPath, "utf8")
const conf = JSON.parse(confOriginal)
const version = conf.version
const GITHUB_REPO = process.env.GITHUB_REPO ?? "roberts9012062/ai-trading-desktop"
const RELEASE_BASE = `https://github.com/${GITHUB_REPO}/releases/download/v${version}`
const KEY_PATH =
  process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ??
  join(root, "证书", "ai-trading-desktop-updater.key")
const notes = process.argv[2] ?? `ai-trading-desktop ${version}`

// 私钥来源:CI 用环境变量 TAURI_SIGNING_PRIVATE_KEY;本地默认密钥文件
const hasKeyEnv = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY)
if (!hasKeyEnv && !existsSync(KEY_PATH)) {
  console.error(`缺少签名私钥(环境变量 TAURI_SIGNING_PRIVATE_KEY 或文件 ${KEY_PATH})`)
  process.exit(1)
}

console.log(`版本 ${version},签名私钥 ${KEY_PATH}\n先结束正在运行的应用实例(否则 exe 被锁,链接失败)...`)
try {
  execSync("taskkill /IM ai-trading-desktop.exe /F", { stdio: "ignore" })
} catch {
  // 没有运行实例,忽略
}

console.log("开始签名构建(本地约 2-4 分钟,CI 约 8-15 分钟)...")
const buildEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }
if (!hasKeyEnv) {
  buildEnv.TAURI_SIGNING_PRIVATE_KEY = readFileSync(KEY_PATH, "utf8")
  buildEnv.TAURI_SIGNING_PRIVATE_KEY_PATH = KEY_PATH
}
execSync("pnpm tauri build", { cwd: root, stdio: "inherit", env: buildEnv })

const nsisDir = join(root, "src-tauri/target/release/bundle/nsis")
if (!existsSync(nsisDir)) throw new Error("找不到 NSIS 产物目录")
const setupExe = readdirSync(nsisDir).find((f) => f.endsWith("-setup.exe"))
const sigFile = `${setupExe}.sig`
if (!setupExe || !existsSync(join(nsisDir, sigFile))) {
  throw new Error(`缺少安装包或签名文件(bundle.createUpdaterArtifacts=true):${nsisDir}`)
}

const outDir = join(root, "update-dist")
mkdirSync(outDir, { recursive: true })
copyFileSync(join(nsisDir, setupExe), join(outDir, setupExe))
copyFileSync(join(nsisDir, sigFile), join(outDir, sigFile))
writeFileSync(join(outDir, "release-notes.txt"), notes, "utf8")

const signature = readFileSync(join(nsisDir, sigFile), "utf8").trim()
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    windows: {
      signature,
      url: `${RELEASE_BASE}/${setupExe}`,
    },
  },
}
writeFileSync(join(outDir, "latest.json"), JSON.stringify(latest, null, 2))
console.log(`\n完成(分发走 GitHub Releases v${version}):
  latest.json → ${GITHUB_REPO}/releases/latest/download/latest.json
  资产:${RELEASE_BASE}/${setupExe}
  本地 build-dist 目录 update-dist/ 仅作核对;CI 由 release.yml 自动上传资产`)
