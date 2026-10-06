/**
 * Release 收尾(仅 CI):查资产 → 生成 latest.json(兼容旧客户端的资产 API 链接) →
 * 上传到 Release → 更新 secret gist(updater 的永久清单地址)。
 *
 * 用法:node scripts/gh-release-finalize.mjs <tag> <notes> <version>
 * 环境变量:GH_TOKEN(Actions 自带)、GIST_ID(默认写死本仓库对应 gist)
 */
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const tag = process.argv[2]
const notes = process.argv[3] ?? tag
const version = process.argv[4] ?? tag.replace(/^v/, "")
const GIST_ID = process.env.GIST_ID ?? "373489c602619a435df63257d034849d"
const REPO = process.env.GITHUB_REPOSITORY ?? "roberts9012062/ai-trading-desktop"

function gh(args) {
  return execSync(`gh ${args}`, { env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim()
}

// 1) 查 Release 资产 ID(setup.exe / .sig)
const release = JSON.parse(gh(`api repos/${REPO}/releases/tags/${tag}`))
const exeAsset = release.assets.find((a) => a.name.includes("-setup.exe"))
const sigAsset = release.assets.find((a) => a.name.endsWith(".sig"))
if (!exeAsset || !sigAsset) throw new Error("Release 缺少 setup.exe / .sig 资产")

// 2) 清单保留资产 API 地址兼容旧客户端；新客户端转换为公开 Release URL。
const signature = readFileSync(
  join(root, "update-dist", sigAsset.name),
  "utf8",
).trim()
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: exeAsset.url, // New desktop updater resolves this to the public versioned download URL.
    },
  },
}
mkdirSync(join(root, "update-dist"), { recursive: true })
writeFileSync(join(root, "update-dist", "latest.json"), JSON.stringify(latest, null, 2))

// 3) latest.json 作为资产上传(备查/回滚)
gh(`release upload ${tag} "update-dist/latest.json" --clobber -R ${REPO}`)

// 4) 更新 secret gist(updater 的永久清单地址;raw 不带 commit 即永远最新)
const gistBody = join(root, "update-dist", "gist-body.json")
writeFileSync(gistBody, JSON.stringify({ files: { "latest.json": { content: JSON.stringify(latest, null, 2) } } }))
// gist 是账号级资源,Actions 的 GITHUB_TOKEN 无权限 → 用 UPDATE_TOKEN(用户级 token)
const gistToken = process.env.GIST_TOKEN || process.env.UPDATE_TOKEN
if (!gistToken) throw new Error("缺少 GIST_TOKEN/UPDATE_TOKEN(gist 更新需要用户级 token)")
execSync(`gh api -X PATCH gists/${GIST_ID} --input "${gistBody}"`, {
  env: { ...process.env, GH_TOKEN: gistToken },
  encoding: "utf8",
})
console.log(`gist 已更新: https://gist.githubusercontent.com/${REPO.split("/")[0]}/${GIST_ID}/raw/latest.json`)
console.log(`latest.json -> 下载链接 ${exeAsset.url}`)
