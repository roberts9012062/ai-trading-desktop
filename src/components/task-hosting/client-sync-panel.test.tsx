import {renderToStaticMarkup} from 'react-dom/server'
import {expect,it,vi} from 'vitest'
const fixture=vi.hoisted(()=>({state:{state:'unavailable',profileName:'admin',errorCode:'configuration_conflict',detail:'synthetic-private-value'}}))
vi.mock('@/lib/taskhost-client-sync',()=>({clientSyncStatus:()=>fixture.state,onClientSyncChange:()=>()=>{},syncCurrentClientConfiguration:vi.fn(),refreshClientServerData:vi.fn(),serverAccountDataFresh:vi.fn(),serverAccountDataIssue:vi.fn(),validServerObservation:vi.fn()}))
import {ClientSyncPanel} from './client-sync-panel'
it('explains a changed-key configuration conflict using fixed text, with no native exception contents',()=>{
 const html=renderToStaticMarkup(<ClientSyncPanel/>);expect(html).toContain('刚删除旧密钥')
 expect(html).toContain('重新同步当前配置');expect(html).not.toContain('synthetic-private-value')
 expect(html).toContain('role="alert"')
})
