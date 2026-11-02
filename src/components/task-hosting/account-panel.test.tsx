import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,it} from 'vitest'
import {AccountPanel} from './account-panel'

const credential={id:'11111111-1111-4111-8111-111111111111',venue:'okx',demo:false,label:'test',api_key_masked:'••••1234'}
it('gates verification on supported server capability and venue',()=>{for(const props of [{available:false,venue:'okx',busy:false},{available:true,venue:'gate',busy:false},{available:true,venue:'okx',busy:true}]){const html=renderToStaticMarkup(createElement(AccountPanel,{credential:{...credential,venue:props.venue},available:props.available,busy:props.busy,onVerify:()=>{},onRead:()=>{}}));expect(html.match(/disabled=""/g)).toHaveLength(2)};const html=renderToStaticMarkup(createElement(AccountPanel,{credential,available:true,busy:false,onVerify:()=>{},onRead:()=>{}}));expect(html).not.toContain('disabled=""')})
it('labels verified data as historical identity without execution authority',()=>{const html=renderToStaticMarkup(createElement(AccountPanel,{credential,available:true,busy:false,onVerify:()=>{},onRead:()=>{},info:{credential_id:credential.id,account_id:'a'.repeat(64),key_fingerprint:'b'.repeat(64),demo:false,revision:'9007199254740993',verified_at:'2026-11-02T12:00:00Z'}}));expect(html).toContain('未注册任务、未取得执行权');expect(html).toContain('9007199254740993')})
