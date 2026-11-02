import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releasePolicy, releaseArguments } from './publish-release.mjs'

test('preview builds are explicit prereleases and cannot replace the stable updater channel', () => {
  const policy = releasePolicy('v0.2.215-go.1', '0.2.215-go.1')
  assert.equal(policy.updateStableManifest, false)
  const args = releaseArguments(policy, 'notes with spaces.txt', ['installer.exe', 'installer.exe.sig', 'latest.json'])
  assert.ok(args.includes('--prerelease'))
  assert.ok(args.includes('--latest=false'))
  assert.deepEqual(args.slice(args.indexOf('--notes-file') + 1, args.indexOf('--notes-file') + 2), ['notes with spaces.txt'])
})

test('stable versions preserve the existing release and manifest workflow', () => {
  const policy = releasePolicy('v0.2.215', '0.2.215')
  assert.equal(policy.updateStableManifest, true)
  const args = releaseArguments(policy, 'notes.txt', ['installer.exe', 'installer.exe.sig'])
  assert.ok(!args.includes('--prerelease'))
  assert.ok(!args.includes('--latest=false'))
})

test('mismatched versions and unsafe tags fail before GitHub receives a release command', () => {
  for (const [tag, version] of [['v0.2.214', '0.2.215-go.1'], ['v../../private', '../../private'], ['v0.2.215;echo', '0.2.215;echo']]) {
    assert.throws(() => releasePolicy(tag, version))
  }
})
