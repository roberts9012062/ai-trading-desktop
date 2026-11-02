"""UI/IPC contract acceptance with synthetic accounts; every business call is blocked
in standalone. Actual signed exchange transport is verified separately in Rust.
"""
import json,os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent/'.local-data'/'standalone-account'
root.mkdir(parents=True,exist_ok=True)
state={'credential':None,'calls':[],'business':[]};errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1350,'height':1100})
    def native(source,command,a=None):
        a=a or {};state['calls'].append({'command':command,'path':a.get('path'),'method':a.get('method')})
        print(json.dumps({'stage':'native-ipc','command':command,'path':a.get('path'),'method':a.get('method')}),flush=True)
        if command=='collection_key':return {'configured':True}
        if command=='okx_analytics_clear':return None
        if command=='collection_http':return {'code':200,'data':{'active_packages':[{'markets':['crypto'],'capabilities':['okx_private','okx_private_ws'],'expires_at':'2099-01-01T00:00:00Z','connections':5,'rpm':120}]}}
        assert command=='desktop_local_exchange',command
        path=a['path'];method=a['method']
        if path=='/api/live/credentials':
            if method=='PUT':
                assert a['body']['demo'] is False
                state['credential']={'venue':'okx','demo':False,'api_key_masked':'synthetic…','account_binding':None,'storage':'local','updated_at':'2026-11-02T00:00:00Z','status':'active'}
                return {'ok':True,'storage':'local'}
            return {'credentials':[state['credential']] if state['credential'] else []}
        if path=='/api/live/permission':return {'enabled':False,'message':'No financial authorization'}
        if path.startswith('/api/live/account?'):assert state['credential'];return {'equity':321,'available':300,'unrealized_pnl':2,'demo':False,'venue_name':'OKX'}
        if path=='/api/live/credentials/okx':state['credential']=None;return {'ok':True}
        raise AssertionError('Unexpected native route '+path)
    context.expose_binding('qaNative',native)
    context.add_init_script('''window.isTauri=true;window.__TAURI_INTERNALS__={invoke:(command,args)=>window.qaNative(command,args)};localStorage.setItem('access_token','synthetic-account-fixture');localStorage.setItem('qihuo_auth_user',JSON.stringify({id:'account-fixture',username:'fixture',trading_mode:'live',role:'user'}));window.__QH_API_BASE__='';''')
    page=context.new_page();page.set_default_timeout(60000);page.on('pageerror',lambda error:errors.append(str(error)))
    def business(route):
        path=urlsplit(route.request.url).path
        if not path.startswith('/api/'):route.continue_();return
        state['business'].append(path)
        assert page.evaluate("localStorage.getItem('atd_account_transport')")=='server','standalone contacted business'
        if path=='/api/live/credentials':route.fulfill(json={'credentials':[]});return
        if path=='/api/live/permission':route.fulfill(json={'enabled':False});return
        if path.startswith('/api/live/account'):route.fulfill(json={'equity':777,'available':700,'unrealized_pnl':1,'demo':False});return
        route.fulfill(status=503,json={'detail':'business disabled'})
    page.route('**/api/**',business)
    page.route('**/fonts.googleapis.com/**',lambda r:r.abort())
    page.goto(os.environ.get('QA_BASE','http://127.0.0.1:5175')+'/scripts/standalone-account-preview.html',wait_until='commit',timeout=90000)
    print('preview committed',flush=True)
    page.get_by_role('button',name='配置 API 凭证',exact=True).click()
    page.get_by_placeholder('输入 API Key',exact=True).fill('synthetic-local-key')
    page.get_by_placeholder('输入 Secret',exact=True).fill('synthetic-local-secret')
    page.get_by_placeholder('输入口令',exact=True).fill('synthetic-local-passphrase')
    page.get_by_role('checkbox').uncheck()
    page.get_by_role('button',name='保存',exact=True).click()
    print('local credential saved',flush=True)
    page.get_by_role('button',name='测试连通',exact=True).click()
    page.get_by_text('连通正常 · 权益 321.00 USDT',exact=True).wait_for()
    print('native readonly query passed',flush=True)
    assert state['credential'] and not state['business']
    denied=page.evaluate("async()=>{try{await accountQA.closeLivePositionApi('okx','btcusdt','long');return false}catch(e){return /交易授权|账户绑定|仅可读取/.test(e.message)}}")
    assert denied
    print('financial action rejected',flush=True)
    assert not any(c['method'] in ['POST','DELETE'] for c in state['calls'])
    page.screenshot(path=str(root/'standalone-account.png'),full_page=True)
    native_before=len(state['calls'])
    with page.expect_navigation(wait_until='commit'):
        page.get_by_role('button',name='服务器模式',exact=True).click()
    page.wait_for_function('!!window.accountQA')
    server=page.evaluate("async()=>accountQA.getLiveAccountApi('okx')")
    assert server['total_equity']==777
    assert not any(c['command']=='desktop_local_exchange' for c in state['calls'][native_before:])
    assert state['credential'] is not None
    with page.expect_navigation(wait_until='commit'):
        page.get_by_role('button',name='单机模式',exact=True).click()
    page.get_by_role('button',name='测试连通',exact=True).wait_for()
    assert page.evaluate("localStorage.getItem('atd_account_transport')")=='standalone'
    assert not errors,errors
    report={'synthetic_accounts':True,'native_ipc_mock':True,'standalone_business_requests':0,'unbound_real_account_configured':True,'local_credential_retained_after_save':True,'readonly_account_result':321,'financial_action_rejected':denied,'server_mode_http_result':777,'local_copy_preserved_across_modes':True,'page_errors':errors}
    (root/'browser-evidence.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report))
    browser.close()
