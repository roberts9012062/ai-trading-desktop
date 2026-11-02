/** Version-aware publication. Preview installers never update the stable gist. */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function releasePolicy(tag, version) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag)
  if (!match || tag !== `v${version}`) throw new Error('Release tag must match the exact configured semantic version')
  return { tag, prerelease: Boolean(match[4]), updateStableManifest: !match[4] }
}

export function releaseArguments(policy, notesFile, assets) {
  return ['release', 'create', policy.tag, '--title', policy.tag, '--notes-file', notesFile,
    ...(policy.prerelease ? ['--prerelease', '--latest=false'] : []), ...assets]
}

export function selectVersionedInstaller(files, version) {
  releasePolicy(`v${version}`, version)
  const expected = `ai-trading-desktop_${version}_x64-setup.exe`
  if (files.filter(name => name === expected).length !== 1) throw new Error('Exact versioned installer is missing')
  return expected
}

function main() {
  const root = resolve(import.meta.dirname, '..')
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
  const policy = releasePolicy(process.argv[2], config.version)
  const directory = join(root, 'update-dist')
  const notesFile = join(directory, 'release-notes.txt')
  const installer = join(directory, `ai-trading-desktop_${config.version}_x64-setup.exe`)
  const assets = [installer, `${installer}.sig`, ...(policy.prerelease ? [join(directory, 'latest.json')] : [])]
  for (const filename of [notesFile, ...assets]) if (!existsSync(filename)) throw new Error(`Release artifact missing: ${filename}`)
  const result = spawnSync('gh', releaseArguments(policy, notesFile, assets), { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('GitHub release publication failed')
  console.log(policy.prerelease ? 'Preview release published; stable updater manifest remains unchanged.' : 'Stable release published; continue with manifest finalization.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
