import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {loginHost,hostSession,logoutHost} from './taskhost-client';
import {saveOnlineStandbyKey} from './taskhost-standalone';
const bridge=vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke:bridge,isTauri:()=>true}));
beforeEach(()=>{bridge.mockReset();vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()});vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',initialized:true}))).mockResolvedValueOnce(new Response(JSON.stringify({service:'taskhost-go',access_token:'fixture',owner_id:'owner',expires_at:new Date(Date.now()+60000).toISOString()}))));logoutHost();});
afterEach(()=>{logoutHost();vi.unstubAllGlobals();});
it('binds the online standby to independently confirmed center identity without persisting its key in the session',async()=>{
  await loginHost('https://fixture.invalid','thk_'+'a'.repeat(43));const before=hostSession()!;
  bridge.mockResolvedValue({permissions:{user_id:'center-user'}});
  await saveOnlineStandbyKey('ac_fixture_only_123456789','center-user',before);
  expect(hostSession()).toMatchObject({mode:'server',centerScope:'taskhost:standalone:center-user'});
  expect(JSON.stringify(hostSession())).not.toContain('ac_fixture');expect(bridge.mock.calls.map(([,args])=>args.action)).toEqual(['test','save']);
});
it('does not save or start a standby under another center identity',async()=>{
  await loginHost('https://fixture.invalid','thk_'+'a'.repeat(43));bridge.mockResolvedValue({permissions:{user_id:'other-user'}});
  await expect(saveOnlineStandbyKey('ac_fixture_only_123456789','center-user',hostSession()!)).rejects.toThrow('不一致');
  expect(bridge).toHaveBeenCalledTimes(1);expect(hostSession()).not.toHaveProperty('centerScope');
});
