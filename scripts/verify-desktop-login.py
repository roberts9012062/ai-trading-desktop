"""Login-first acceptance with synthetic accounts and intercepted business IO."""
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent/'.local-data'/'login-first'
root.mkdir(parents=True,exist_ok=True)
user={'id':'login-fixture','username':'fixture','role':'user','trading_mode':'virtual','status':'active'}
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1280,'height':900})
    context.add_init_script('''(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(target,args){const ws=new EventTarget();ws.send=()=>{};ws.close=()=>{};return ws}})})()''')
    context.add_init_script('''if(!localStorage.getItem('login-qa-seeded')){localStorage.setItem('login-qa-seeded','1');localStorage.setItem('access_token','cached-test-access');localStorage.setItem('refresh_token','cached-test-refresh');localStorage.setItem('qihuo_auth_user',JSON.stringify(%s));localStorage.setItem('cached-market-marker','keep-market');localStorage.setItem('task-record-marker','keep-tasks')}'''%json.dumps(user))
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    state={'me':'ok','calls':[]}
    def api(route):
        path=urlsplit(route.request.url).path;state['calls'].append((path,route.request.method))
        if path=='/api/auth/desktop-login':
            body=route.request.post_data_json
            if body['password']!='correct-test-password':route.fulfill(status=401,json={'detail':'密码错误'});return
            route.fulfill(json={'access_token':'new-test-access','refresh_token':'new-test-refresh'});return
        if path=='/api/auth/me':
            if state['me']!='ok':route.fulfill(status=int(state['me']),json={'detail':'测试服务器不可用'});return
            route.fulfill(json=user);return
        if '/paper/account' in path:route.fulfill(json={'account_id':'test','total_equity':1000,'available_margin':1000,'unrealized_pnl':0,'today_pnl':0,'risk_rate':0,'frozen_margin':0,'used_margin':0});return
        if any('/paper/'+name in path for name in ('orders','positions','ledgers')):route.fulfill(json={'items':[],'total':0});return
        if any(name in path for name in ('metrics','summary','notify-settings','preferences','overview')):route.fulfill(json={});return
        route.fulfill(json=[])
    page.route('**/api/**',api)
    page.route('**/fonts.googleapis.com/**',lambda r:r.abort())
    page.route('**/fonts.gstatic.com/**',lambda r:r.abort())
    page.goto('http://127.0.0.1:5173/',wait_until='commit',timeout=90000)
    page.wait_for_url('**/login',timeout=90000)
    page.get_by_label('用户名',exact=True).wait_for(timeout=30000)
    assert not any(path=='/api/auth/me' for path,_ in state['calls'])
    assert page.evaluate('localStorage.getItem("access_token")')=='cached-test-access'
    print('Cached credentials stayed on login',flush=True)
    page.goto('http://127.0.0.1:5173/market',wait_until='commit')
    try:page.wait_for_url('**/login',timeout=60000)
    except Exception:
        print(json.dumps({'url':page.url,'errors':errors,'text':page.inner_text('body')[:700],'gate':page.evaluate('''async()=>{const s=await import('/src/lib/desktop-login-session.ts');return {required:s.desktopLoginRequired(),mode:s.desktopSessionLocalOnly(),run:sessionStorage.getItem('atd_browser_run'),verified:sessionStorage.getItem('atd_verified_login_run')}}'''),'calls':state['calls']},ensure_ascii=True),flush=True)
        raise
    page.get_by_label('用户名',exact=True).fill('fixture')
    page.get_by_label('密码',exact=True).fill('wrong-test-password')
    page.get_by_role('button',name='登录',exact=True).click()
    page.get_by_text('密码错误',exact=True).wait_for()
    assert urlsplit(page.url).path=='/login'
    page.get_by_label('密码',exact=True).fill('correct-test-password')
    page.get_by_role('button',name='登录',exact=True).click()
    page.wait_for_url('**/dashboard',timeout=30000)
    print('Explicit login reached dashboard',page.evaluate('localStorage.getItem("access_token")'),flush=True)
    page.reload(wait_until='commit');page.wait_for_url('**/dashboard',timeout=30000)
    try:page.wait_for_function('localStorage.getItem("access_token")==="new-test-access"',timeout=10000)
    except Exception:
        print(json.dumps({'after_reload_token':page.evaluate('localStorage.getItem("access_token")'),'url':page.url,'errors':errors,'calls':state['calls'],'seed':page.evaluate('localStorage.getItem("login-qa-seeded")')},ensure_ascii=True),flush=True)
        raise
    # Restoring a hidden window asks again without clearing data/credentials.
    page.evaluate('window.dispatchEvent(new Event("desktop-login-required"))')
    page.wait_for_url('**/login',timeout=10000)
    # Present native-only continuation after the browser-only boot, using an
    # inert IPC adapter. No native worker or exchange action is sent.
    page.evaluate('''()=>{window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback:()=>{},invoke:async(cmd,args)=>{if(cmd==='collection_key')return {configured:false};if(cmd==='desktop_db')return args?.action==='status'?{pending:0,conflicts:0}:[];return false}}}''')
    page.get_by_label('用户名',exact=True).fill('fixture-native')
    local=page.get_by_role('button',name='进入本机离线会话（fixture）',exact=True)
    local.wait_for(timeout=10000)
    state['me']=503;local.click()
    page.wait_for_url('**/dashboard',timeout=15000)
    assert page.evaluate('''async()=>{const s=await import('/src/lib/desktop-login-session.ts');return s.desktopSessionLocalOnly()}''')
    blocked=page.evaluate('''async()=>{const {createServerTask}=await import('/src/lib/server-task.ts');try{await createServerTask('','/api/ai-trading/tasks',{});return false}catch(e){return e.code==='LOCAL_SESSION_ONLY'}}''')
    assert blocked
    assert not any(path=='/api/ai-trading/tasks' and method=='POST' for path,method in state['calls'])
    state['me']='ok'
    page.reload(wait_until='commit');page.wait_for_url('**/dashboard',timeout=30000)
    page.wait_for_function('''async()=>{const s=await import('/src/lib/desktop-login-session.ts');return !s.desktopLoginRequired()&&s.desktopSessionLocalOnly()}''')
    # A fresh application identifier invalidates this launch confirmation.
    page.evaluate('sessionStorage.setItem("atd_browser_run","another-test-launch")')
    page.reload(wait_until='commit');page.wait_for_url('**/login',timeout=30000)
    assert page.evaluate('localStorage.getItem("cached-market-marker")')=='keep-market'
    assert page.evaluate('localStorage.getItem("task-record-marker")')=='keep-tasks'
    page.screenshot(path=str(root/'login-first.png'))
    report={'cached_token_starts_at_login':True,'protected_deep_link_blocked':True,'wrong_password_stays_at_login':True,'explicit_login_enters_dashboard':True,'same_run_reload_preserved':True,'window_restore_requires_confirmation':True,'manual_local_continuation':True,'local_task_creation_blocked':True,'local_restriction_survives_server_return':True,'fresh_launch_requires_login':True,'cached_data_preserved':True,'page_errors':errors}
    (root/'browser-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    assert not errors,errors
    print(json.dumps(report,ensure_ascii=True),flush=True)
    browser.close()
