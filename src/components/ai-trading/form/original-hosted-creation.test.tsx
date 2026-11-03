// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,it,expect,vi,type Mock} from 'vitest'
const fixture=vi.hoisted(()=>({create:vi.fn()}))
vi.mock('@/stores/ai-trading',()=>({useAITradingStore:(select:(s:unknown)=>unknown)=>select({createTask:fixture.create})}))
vi.mock('@/stores/market',()=>({useMarketStore:(select:(s:unknown)=>unknown)=>select({quotes:{}})}))
vi.mock('@/stores/auth',()=>({useAuthStore:(select:(s:unknown)=>unknown)=>select({user:{trading_mode:'live'}})}))
vi.mock('@/lib/api',async()=>({getAIModels:(await import('@/lib/taskhost-original-create')).originalHostModels}))
vi.mock('./symbol-picker',()=>({SymbolPicker:({onChange}:{onChange:(s:string,n:string)=>void})=><button type="button" onClick={()=>onChange('btcusdt','比特币')}>选择验收合约</button>}))
vi.mock('./ai-factor-mount',()=>({AiFactorMount:()=>null}))
vi.mock('./ai-quant-ref-picker',()=>({AiQuantRefPicker:()=>null}))
import {CreateTaskDialog} from './create-task-dialog'
import {createAITradingTask} from '@/lib/ai-trading-api'
import {loginHost,logoutHost} from '@/lib/taskhost-client'
import {initializeDesktopLoginSession} from '@/lib/desktop-login-session'
const credential='11111111-1111-4111-8111-111111111111',model='22222222-2222-4222-8222-222222222222',task='33333333-3333-4333-8333-333333333333'
let root:Root,container:HTMLDivElement,created:Record<string,unknown>[],closed:Mock<()=>void>
beforeEach(async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();sessionStorage.clear();created=[];closed=vi.fn()
 initializeDesktopLoginSession('original-modal-fixture',sessionStorage);logoutHost()
 vi.stubGlobal('fetch',vi.fn(async(u,o)=>{
  const path=new URL(String(u),'http://fixture.invalid').pathname
  if(path==='/api/health')return Response.json({service:'taskhost-go',initialized:true})
  if(path==='/api/v1/handshake')return Response.json({service:'taskhost-go',access_token:'fixture',owner_id:'fixture-owner',expires_at:new Date(Date.now()+60000).toISOString()})
  if(path==='/api/v1/credentials')return Response.json({credentials:[{id:credential,venue:'okx',label:'原本地配置同步账户',demo:true,api_key_masked:'fixture…'}]})
  if(path==='/api/v1/models')return Response.json({models:[{id:model,name:'原模型选择框',kind:'openai',model_id:'fixture-model'}]})
  if(path==='/api/v1/managed-capabilities')return Response.json({protocol:'taskhost-managed-v1',runtime_available:true,managed_tasks:true,create_requires_server:true,execution_authority:false,standalone_creation:false,center_control_protocol:'task-control-v1'})
  if(path.endsWith('/verify-account'))return Response.json({account:{credential_id:credential,account_id:'a'.repeat(64),key_fingerprint:'b'.repeat(64),demo:true,revision:'1',verified_at:new Date().toISOString()},execution_authority:false,registration_enabled:false});if(path==='/api/v1/managed-tasks'){created.push(JSON.parse(String(o?.body)));return Response.json({task:{id:task,name:'fixture',kind:'ai',symbol:'btcusdt',timeframe:'5m',credential_id:credential,model_id:model,account_id:'a'.repeat(64),status:'observing',revision:'1',control_version:'0',desired_state:'paused',registration:'prepared'},execution_authority:false})}
  if(path==='/api/ai-trading/funding-source')return Response.json({source:'live',bound:true,venue:'okx',demo:true,balance_usdt:1000,site_balance_usdt:0,trading_mode:'live',error:null})
  throw new Error('Blocked non-fixture request: '+path)
 }))
 await loginHost('https://host.fixture','thk_'+'a'.repeat(43));fixture.create.mockReset().mockImplementation(createAITradingTask)
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();logoutHost();vi.unstubAllGlobals()})
it('submits the existing AI dialog with its original fields to hosting, rather than a separate Go form',async()=>{
 await act(async()=>root.render(<CreateTaskDialog open onClose={closed}/>))
 await vi.waitFor(()=>expect(document.body.textContent).toContain('原模型选择框'))
 expect(document.body.textContent).toContain('创建 AI 交易任务')
 expect(document.body.textContent).toContain('任务名称（可选）')
 expect(document.body.textContent).toContain('每笔保证金')
 expect(document.body.textContent).not.toContain('在线新建任务')
 const account=document.querySelector<HTMLSelectElement>('select[aria-label="服务器交易账户"]')!
 await vi.waitFor(()=>expect(account.value).toBe(credential))
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='选择验收合约')!.click()})
 await act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='创建')!.click()})
 await vi.waitFor(()=>expect(closed).toHaveBeenCalledOnce())
 expect(created).toHaveLength(1)
 expect(created[0]).toMatchObject({kind:'ai',credential_id:credential,model_id:model,symbol:'btcusdt',timeframe:'5m',settings:{margin_per_trade:'100',leverage:10,max_profit_pct:'20',max_loss_pct:'10',loss_cooldown_enabled:true}})
 expect(created[0].name).toBe('原模型选择框·比特币·5m')
 expect(localStorage.getItem('access_token')).toBeNull()
})
