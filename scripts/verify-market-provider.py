"""Opt-in real public IO with an isolated business fixture; no financial writes.

COLLECTION_LIVE_KEY is supplied only to this process. QA_PROXY is optional and
never packaged as user configuration. Run against a fresh local Vite server.
"""
import json, os, time
from pathlib import Path
from urllib.parse import urlsplit
import requests
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent/'.local-data'/'market-provider'
root.mkdir(parents=True,exist_ok=True)
user={'id':'provider-fixture','username':'fixture','role':'user','trading_mode':'virtual','status':'active'}
proxy=os.environ.get('QA_PROXY')
http=requests.Session();http.trust_env=False
if proxy:http.proxies={'http':proxy,'https':proxy}
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True,**({'proxy':{'server':proxy,'bypass':'localhost,127.0.0.1'}} if proxy else {}))
    context=browser.new_context(viewport={'width':1600,'height':1000})
    context.add_init_script('''localStorage.setItem('access_token','synthetic-readonly-fixture');localStorage.setItem('qihuo_auth_user',JSON.stringify(%s));sessionStorage.setItem('atd_browser_run','provider-qa');sessionStorage.setItem('atd_verified_login_run','browser:provider-qa');(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(target,args){const u=new URL(args[0],location.href);if(['ws.okx.com','wspap.okx.com','lium.eu.org'].includes(u.hostname))return new target(...args);const ws=new EventTarget();ws.send=()=>{};ws.close=()=>{};return ws}})})()'''%json.dumps(user))
    page=context.new_page();page.set_default_timeout(60000)
    errors=[];requests_seen=[];sockets=[];frames=[];modules={}
    page.on('pageerror',lambda e:errors.append(str(e)))
    def request(req):
        path=urlsplit(req.url).path
        if path in ['/src/lib/collection-config.ts','/src/lib/market-provider.ts','/src/stores/market.ts','/src/stores/app.ts']:modules.setdefault(path,req.url)
        if path.startswith(('/__collection__/','/__okx_direct__/')):requests_seen.append(path)
    page.on('request',request)
    def socket(ws):
        info={'host':urlsplit(ws.url).hostname,'path':urlsplit(ws.url).path,'closed':False};sockets.append(info)
        ws.on('close',lambda:info.update(closed=True))
        def frame(raw):
            try:
                row=json.loads(raw)
                if row.get('payload') or row.get('data'):frames.append({'host':info['host'],'kind':row.get('kind') or row.get('arg',{}).get('channel'),'at':time.monotonic()})
            except (ValueError,AttributeError):pass
        ws.on('framereceived',frame)
    page.on('websocket',socket)
    def business(route):
        path=urlsplit(route.request.url).path
        if not path.startswith('/api/'):route.continue_();return
        if path=='/api/auth/me':route.fulfill(json=user);return
        if '/paper/account' in path:route.fulfill(json={'account_id':'fixture','total_equity':1000,'available_margin':1000,'unrealized_pnl':0,'today_pnl':0,'risk_rate':0,'frozen_margin':0,'used_margin':0});return
        if any('/paper/'+part in path for part in ['orders','positions','ledgers']):route.fulfill(json={'items':[],'total':0});return
        if any(part in path for part in ['metrics','summary','notify-settings','preferences','overview']):route.fulfill(json={});return
        route.fulfill(json=[])
    page.route('**/api/**',business)
    def relay(route):
        req=route.request;parts=urlsplit(req.url)
        center=parts.path.startswith('/__collection__/')
        path=parts.path.removeprefix('/__collection__' if center else '/__okx_direct__')
        assert req.method=='GET' or center and path=='/api/tickets'
        if req.method=='POST':assert req.post_data_json['operation'] in ['history','ticks','quotes','stream_bars','stream_quotes','stream_ticks']
        headers={'X-API-Key':req.headers['x-api-key']} if 'x-api-key' in req.headers else {}
        response=http.request(req.method,('https://lium.eu.org' if center else 'https://www.okx.com')+path+('?' + parts.query if parts.query else ''),headers=headers,json=req.post_data_json if req.method=='POST' else None,timeout=30)
        route.fulfill(status=response.status_code,body=response.content,content_type='application/json')
    page.route('**/__okx_direct__/**',relay);page.route('**/__collection__/**',relay)
    page.route('**/fonts.googleapis.com/**',lambda r:r.abort())
    page.goto(os.environ.get('QA_BASE','http://127.0.0.1:5173')+'/market',wait_until='commit',timeout=90000)
    try:page.wait_for_function('document.querySelectorAll("canvas").length>0',timeout=90000)
    except Exception:
        page.screenshot(path=str(root/'failure.png'),full_page=True)
        print(json.dumps({'stage':'initial-page-failed','path':urlsplit(page.url).path,'text':page.inner_text('body')[:1800],'page_errors':errors,'requests':requests_seen},ensure_ascii=True),flush=True)
        raise
    page.wait_for_timeout(8000)
    assert any(s['host']=='ws.okx.com' for s in sockets)
    assert not any(path.startswith('/__collection__/') for path in requests_seen)
    print(json.dumps({'stage':'no-key-direct-okx','sockets':len(sockets)}),flush=True)
    page.evaluate('''async({modules,key})=>{const c=await import(modules['/src/lib/collection-config.ts']);await c.collectionKeyAction('save',key)}''',{'modules':modules,'key':os.environ['COLLECTION_LIVE_KEY']})
    mark=len(requests_seen);saved=time.monotonic();socket_mark=len(sockets)
    def state():return page.evaluate('''async urls=>{const c=await import(urls['/src/lib/collection-config.ts']),p=await import(urls['/src/lib/market-provider.ts']),m=await import(urls['/src/stores/market.ts']);const s=m.useMarketStore.getState();return {configured:c.collectionStatus().configured,direct:p.directOkxMode(),quotes:Object.keys(s.quotes).length,trades:s.trades.btcusdt?.length||0,depth:!!s.orderbooks.btcusdt,candle:Math.max(0,...Object.values(s.klineRealtime.btcusdt||{}).map(b=>b.version||0)),canvas:document.querySelectorAll('canvas').length,error:c.collectionStatus().error}}''',modules)
    # Wait for genuine relay payloads, not just retained direct snapshots.
    for _ in range(60):
        page.wait_for_timeout(1000)
        kinds={row['kind'] for row in frames if row['host']=='lium.eu.org' and row['at']>saved}
        if {'candle','tick'}.issubset(kinds) or any('bar' in str(k) for k in kinds) and any('tick' in str(k) or 'trade' in str(k) for k in kinds):break
    first=state();page.wait_for_timeout(7000);second=state()
    assert second['configured'] and not second['direct'] and second['quotes']==60 and second['trades']>0 and second['depth'] and second['canvas']>0,second
    assert second['candle']>first['candle']>0,(first,second)
    assert any(f['host']=='lium.eu.org' and f['at']>saved for f in frames)
    assert not any(path.startswith('/__okx_direct__/') for path in requests_seen[mark:])
    assert all(s['closed'] for s in sockets if s['host']=='ws.okx.com')
    assert all(s['host']=='lium.eu.org' for s in sockets[socket_mark:])
    # Explicit removal switches back; service failures themselves never do so.
    page.evaluate('''async urls=>{const c=await import(urls['/src/lib/collection-config.ts']);await c.collectionKeyAction('clear')}''',modules)
    page.wait_for_timeout(8000)
    assert state()['direct'] is True
    assert not errors,errors
    report={'real_public_io':True,'business_identity':'synthetic fixture','financial_writes':False,'configured_state':second,'requests':requests_seen,'websockets':sockets,'frame_kinds':sorted({str(f['kind']) for f in frames if f['host']=='lium.eu.org'}),'page_errors':errors,'explicit_clear_restores_direct':True}
    (root/'browser-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    page.screenshot(path=str(root/'market-provider.png'),full_page=True)
    print(json.dumps(report,ensure_ascii=True),flush=True)
    browser.close()
