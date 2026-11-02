import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,it} from 'vitest'
import {SnapshotPanel} from './snapshot-panel'

it('keeps actions disabled on old servers and exposes historical status honestly',()=>{
  const html=renderToStaticMarkup(createElement(SnapshotPanel,{available:false,busy:false,onSync:()=>{},onRead:()=>{}}))
  expect(html.match(/disabled=""/g)).toHaveLength(2)
  expect(html).toContain('v0.1.1');expect(html).toContain('不会启动任务')
})
it('displays exact checkpoint versions and disables actions while syncing',()=>{
  const html=renderToStaticMarkup(createElement(SnapshotPanel,{available:true,busy:true,onSync:()=>{},onRead:()=>{},info:{account_id:'a'.repeat(64),revision:'1',checkpoint_seq:'9007199254740993',epoch:'4',record_count:2,task_count:1,synced_at:'2026-11-02T08:00:00Z'}}))
  expect(html).toContain('9007199254740993');expect(html.match(/disabled=""/g)).toHaveLength(2);expect(html).toContain('不代表已取得执行权')
})
