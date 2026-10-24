"""Opt-in real public-market check; supply COLLECTION_LIVE_KEY in the environment."""
import json, os, time
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent/'.local-data'/'collection-startup'
root.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1400,'height':900})
    context.add_init_script('''(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(target,args){if(args[1]==='vite-hmr'||String(args[0]).startsWith('wss://lium.eu.org/')){const ws=new EventTarget();ws.send=()=>{};ws.close=()=>{};return ws}return Reflect.construct(target,args)}})})()''')
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('console',lambda m:print(m.text,flush=True) if m.type=='warning' and '启动历史缓存' in m.text else None)
    page.route('**/api/**',lambda r:r.continue_() if '/__collection__/' in r.request.url else r.fulfill(json={'code':200,'data':[]}))
    page.route('**/fonts.googleapis.com/**',lambda r:r.abort())
    page.route('**/fonts.gstatic.com/**',lambda r:r.abort())
    page.goto('http://127.0.0.1:5173/scripts/collection-chart-preview.html',wait_until='commit',timeout=90000)
    page.wait_for_function('!!window.chartQA',timeout=90000)
    snapshot=root/'public-cache.json'
    if snapshot.exists():
        page.evaluate('''async rows=>{const {openDb,idbPut,KLINE_HISTORY_STORE}=await import('/src/lib/idb.ts');const db=await openDb();for(const row of rows)await idbPut(db,KLINE_HISTORY_STORE,row)}''',json.loads(snapshot.read_text(encoding='utf-8')))
    print('Starting public cache preparation',flush=True)
    began=time.monotonic()
    warm=page.evaluate('(key)=>chartQA.warmup(key,["btcusdt","ethusdt"],["1d","1m"])',os.environ['COLLECTION_LIVE_KEY'])
    snapshot.write_text(json.dumps(page.evaluate('''async()=>{const {openDb,idbGetAll,KLINE_HISTORY_STORE}=await import('/src/lib/idb.ts');return idbGetAll(await openDb(),KLINE_HISTORY_STORE)}''')),encoding='utf-8')
    assert warm=={'running':False,'done':4,'failed':0,'total':4},warm
    print('Startup cache prepared',flush=True)
    report={'startup_seconds':round(time.monotonic()-began,2),'warmup':warm}
    page.evaluate('''()=>{window.qaHttp=[];window.qaNetworkDelay=5000;const original=window.fetch;window.fetch=async(input,options)=>{const path=String(input);if(path.includes('/__collection__/edge/data?'))await new Promise(r=>setTimeout(r,window.qaNetworkDelay));const response=await original(input,options);if(path.includes('/__collection__/')){const data=await response.clone().json().catch(()=>({}));window.qaHttp.push({path:path.split('?')[0],status:response.status,code:data.code,msg:data.msg})}if(path.includes('/v1/my/permissions')){const value=await response.clone().json();for(const grant of value.data.active_packages)grant.connections=3;return new Response(JSON.stringify(value),{status:response.status,headers:response.headers})}return response};window.switchRequestStart=chartQA.requests.length}''')
    assert page.evaluate('(key)=>chartQA.start(key)',os.environ['COLLECTION_LIVE_KEY'])==60
    def ready(symbol,period,n):
        page.wait_for_function('([s,p,n])=>chartQA.snapshot().bars[s]?.[p]?.length>=n&&!chartQA.snapshot().loading[s+":"+p]',arg=[symbol,period,n],timeout=2500)
        assert page.get_by_text('首次下载 K 线缓存…',exact=True).count()==0
        assert '正在核对本地' not in page.inner_text('body')
    ready('btcusdt','1d',240)
    page.evaluate('chartQA.select("ethusdt")');ready('ethusdt','1d',240)
    page.get_by_role('button',name='1分',exact=True).click();ready('ethusdt','1m',4321)
    began=time.monotonic();page.evaluate('chartQA.select("btcusdt")');ready('btcusdt','1m',4321)
    report['cached_switch_seconds']=round(time.monotonic()-began,3)
    # The cache must draw before the deliberately delayed history response.
    assert report['cached_switch_seconds']<2.5
    print('Cached views rendered before delayed network',report['cached_switch_seconds'],flush=True)
    page.evaluate('window.qaNetworkDelay=0')
    try:
        page.wait_for_function('chartQA.snapshot().trades.btcusdt?.length>0',timeout=45000)
    except Exception:
        print(json.dumps({'http':page.evaluate('window.qaHttp'),'requests':page.evaluate('chartQA.requests.slice(window.switchRequestStart)'),'page_errors':errors},ensure_ascii=True),flush=True)
        raise
    first=page.evaluate('Math.max(...chartQA.snapshot().trades.btcusdt.map(r=>Number(r.ts)))')
    page.wait_for_function('(t)=>Math.max(...chartQA.snapshot().trades.btcusdt.map(r=>Number(r.ts)))>t',arg=first,timeout=35000)
    rows=page.evaluate('chartQA.snapshot().trades.btcusdt')
    assert all(len(row['time'])==12 and row['time'][8]=='.' for row in rows)
    assert len({row['time'] for row in rows})>1
    assert [float(row['ts']) for row in rows]==sorted([float(row['ts']) for row in rows],reverse=True)
    histories=page.evaluate('chartQA.requests.slice(window.switchRequestStart).filter(r=>r.operation==="history")')
    assert all(row['count']<=10 and row.get('end') is None for row in histories),histories
    report.update({'switch_history_requests':histories,'trade_rows':len(rows),'unique_trade_times':len({row['time'] for row in rows}),'fresh_trade_time':rows[0]['time'],'trade_recovery_without_socket':True,'page_errors':errors})
    assert not errors,errors
    page.screenshot(path=str(root/'startup-and-trades.png'))
    (root/'browser-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=True),flush=True)
    browser.close()
