// @vitest-environment happy-dom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'

const fixture=vi.hoisted(()=>({user:{id:'preserved-profile',username:'Original profile',role:'admin',trading_mode:'live'},getMe:vi.fn(),legacyLogout:vi.fn(),market:{codeTree:{},initWebSocket:vi.fn(),fetchCodeTree:vi.fn().mockResolvedValue(undefined)}}))
vi.mock('@/stores/auth',()=>({useAuthStore:Object.assign((select?:((s:any)=>unknown))=>{const state={user:fixture.user,accessToken:null,loaded:true,hydrating:false,login:vi.fn(),logout:fixture.legacyLogout,setLoaded:vi.fn(),setHydrating:vi.fn()};return select?select(state):state},{getState:()=>({user:fixture.user,loaded:true}),subscribe:()=>()=>{}})}))
vi.mock('@/stores/market',()=>({useMarketStore:Object.assign((select:(s:any)=>unknown)=>select(fixture.market),{getState:()=>fixture.market})}))
vi.mock('@/stores/notifications',()=>({useNotificationsStore:Object.assign(()=>0,{getState:()=>({fetchUnread:async()=>{}})})}))
vi.mock('@/stores/big-order',()=>({useBigOrderStore:Object.assign((select:(s:any)=>unknown)=>select({settings:{voice_enabled:false}}),{getState:()=>({loadFromServer:async()=>{},settings:{voice_enabled:false}})})}))
vi.mock('@/stores/task-alert',()=>({useTaskAlertStore:{getState:()=>({loadFromServer:async()=>{}})}}))
vi.mock('@/lib/api',()=>({getMeApi:fixture.getMe,getNotifySettingsApi:async()=>({notify_sound_enabled:false})}))
vi.mock('@/lib/voice-broadcast-engine',()=>({startVoiceBroadcastEngine:vi.fn()}))
vi.mock('@/lib/contract-names',()=>({ensureContractNames:async()=>{}}))
vi.mock('@/hooks/keyboard',()=>({useKeyboardShortcuts:vi.fn()}))
vi.mock('@/hooks/sync',()=>({useTabSync:vi.fn(),broadcastContractChange:vi.fn()}))
vi.mock('@/components/layout/top-navbar',()=>({TopNavbar:()=> <header>周期领航 · CyclePilot</header>}))
vi.mock('@/components/profile/data-config-panel',()=>({DataConfigNotice:()=>null}))
vi.mock('@/components/market/contract-search-dialog',()=>({ContractSearchDialog:()=>null}))
vi.mock('@/components/ai/floating-assistant',()=>({FloatingAssistant:()=>null}))
vi.mock('@/components/notifications/announcement-popup',()=>({AnnouncementPopup:()=>null}))
vi.mock('@/components/notifications/message-popup',()=>({MessagePopup:()=>null}))
vi.mock('@/components/notifications/big-order-toast',()=>({BigOrderToastPopup:()=>null}))
vi.mock('@/components/notifications/task-alert-toast',()=>({TaskAlertToastPopup:()=>null}))
vi.mock('@/components/global-dialog',()=>({GlobalDialog:()=>null}))
vi.mock('@/components/trading/live-trading-runtime',()=>({LiveTradingRuntime:()=>null}))
vi.mock('@/components/layout/update-control',()=>({UpdateControl:()=>null}))
vi.mock('@/components/layout/donation-button',()=>({DonationButton:()=>null}))
vi.mock('./components/task-hosting/hosting-page',()=>({default:()=> <h1>Go任务托管内容</h1>}))
vi.mock('./app/(main)/dashboard/page',()=>({default:()=> <h1>工作台内容</h1>}))
vi.mock('./app/(main)/market/page',()=>({default:()=> <h1>行情内容</h1>}))
vi.mock('./app/(main)/trading/page',()=>({default:()=> <h1>交易内容</h1>}))
vi.mock('./app/(main)/ai-trading/page',()=>({default:()=> <h1>AI交易内容</h1>}))
vi.mock('./app/(main)/backtest/page',()=>({default:()=> <h1>回测内容</h1>}))
vi.mock('./app/(main)/factor-lab/page',()=>({default:()=> <h1>因子实验室内容</h1>}))
vi.mock('./app/(main)/positions/page',()=>({default:()=> <h1>持仓内容</h1>}))
vi.mock('./app/(main)/orders/page',()=>({default:()=> <h1>订单内容</h1>}))
vi.mock('./app/(main)/assets/page',()=>({default:()=> <h1>资产内容</h1>}))
vi.mock('./app/(main)/profile/page',()=>({default:()=> <h1>个人内容</h1>}))
vi.mock('./app/(main)/ai-settings/page',()=>({default:()=> <h1>AI设置内容</h1>}))
vi.mock('./app/(main)/manual/page',()=>({default:()=> <h1>手册内容</h1>}))
vi.mock('./app/(main)/strategy-favorites/page',()=>({default:()=> <h1>收藏内容</h1>}))
vi.mock('./app/admin/layout',()=>({default:()=> <h1>不得挂载旧管理员布局</h1>}))

import {AppRoutes} from './router'
import {loginHost,logoutHost,hostSession} from './lib/taskhost-client'
import {initializeDesktopLoginSession,requireDesktopLogin} from './lib/desktop-login-session'
let root:Root,container:HTMLDivElement
beforeEach(async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  localStorage.clear();sessionStorage.clear();fixture.getMe.mockClear();fixture.legacyLogout.mockClear()
  initializeDesktopLoginSession('workspace-ui',sessionStorage);logoutHost()
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',initialized:true}))).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',access_token:'fixture-token',owner_id:'owner-a',expires_at:new Date(Date.now()+300000).toISOString()}))).mockImplementation(async()=>new Response(JSON.stringify({closed:false}))))
  await loginHost('https://host.fixture','thk_'+'a'.repeat(43))
  container=document.createElement('div');document.body.append(container);root=createRoot(container)
})
afterEach(async()=>{await act(async()=>root.unmount());container.remove();logoutHost();vi.unstubAllGlobals()})
async function render(path:string){await act(async()=>{root.render(<MemoryRouter initialEntries={[path]}><AppRoutes/></MemoryRouter>)});for(let i=0;i<40&&!container.querySelector('nav');i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})}
it('mounts the actual original shell and complete navigation around Go task hosting with no JWT',async()=>{
  await render('/task-hosting')
  expect(container.textContent).toContain('周期领航')
  expect(container.textContent).toContain('Go任务托管内容')
  for(const path of ['/dashboard','/market','/ai-market','/trading','/ai-trading','/backtest','/factor-lab','/strategy-favorites','/positions','/orders','/assets','/profile','/ai-settings','/messages','/manual','/task-hosting'])expect(container.querySelector(`nav a[href="${path}"]`),path).not.toBeNull()
  expect(fixture.getMe).not.toHaveBeenCalled()
  expect(fixture.legacyLogout).not.toHaveBeenCalled()
  expect(localStorage.getItem('access_token')).toBeNull()
})
it.each([['/dashboard','工作台内容'],['/market','行情内容'],['/trading','交易内容'],['/ai-trading','AI交易内容'],['/backtest','回测内容'],['/factor-lab','因子实验室内容'],['/positions','持仓内容'],['/orders','订单内容'],['/assets','资产内容'],['/profile','个人内容'],['/ai-settings','AI设置内容'],['/strategy-favorites','收藏内容'],['/manual','手册内容']])('opens original page %s under Go authentication',async(path,text)=>{
  await render(path)
  await vi.waitFor(()=>expect(container.textContent).toContain(text))
  expect(container.querySelector('nav')).not.toBeNull()
  expect(fixture.getMe).not.toHaveBeenCalled()
})
it('keeps navigation mounted when moving from task hosting to an old page',async()=>{
  await render('/task-hosting')
  await act(async()=>container.querySelector<HTMLAnchorElement>('nav a[href="/market"]')!.click())
  await vi.waitFor(()=>expect(container.textContent).toContain('行情内容'))
  expect(container.querySelector('nav a[href="/task-hosting"]')).not.toBeNull()
  expect(hostSession()).toMatchObject({ownerID:'owner-a'})
})
it('does not give the old administrator area to a Go key despite a cached admin profile',async()=>{
  await render('/admin/dashboard')
  await vi.waitFor(()=>expect(container.textContent).toContain('工作台内容'))
  expect(container.textContent).not.toContain('不得挂载旧管理员布局')
})
it('does not mount private page effects from a saved Go bearer before this launch login',async()=>{
  requireDesktopLogin()
  await render('/market')
  expect(container.querySelector('nav')).toBeNull()
  expect(container.textContent).not.toContain('行情内容')
  expect(fixture.getMe).not.toHaveBeenCalled()
})
