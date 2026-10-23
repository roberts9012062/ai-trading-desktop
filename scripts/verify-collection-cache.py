import json, os, time
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent / ".local-data" / "collection-cache"
root.mkdir(parents=True,exist_ok=True)
report={}
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1400,'height':900})
    # Keep developer file edits from reloading a long-running acceptance page.
    # Collection WebSockets use their ordinary native constructor unchanged.
    context.add_init_script('''(()=>{const Native=window.WebSocket;window.WebSocket=new Proxy(Native,{construct(target,args){if(args[1]==='vite-hmr'){const ws=new EventTarget();ws.send=()=>{};ws.close=()=>{};return ws}return Reflect.construct(target,args)}})})()''')
    page=context.new_page(); errors=[]
    page.on('pageerror', lambda e:errors.append(str(e)))
    page.route('**/api/**',lambda r:r.continue_() if '/__collection__/' in r.request.url else r.fulfill(json={'code':200,'data':[]}))
    page.route('**/fonts.googleapis.com/**',lambda r:r.abort())
    page.route('**/fonts.gstatic.com/**',lambda r:r.abort())
    def start():
        page.goto('http://127.0.0.1:5173/scripts/collection-chart-preview.html',wait_until='commit',timeout=90000)
        page.wait_for_function('!!window.chartQA',timeout=90000)
        assert page.evaluate('(key)=>chartQA.start(key)',os.environ['COLLECTION_LIVE_KEY'])==60
    def wait(period,n):
        page.wait_for_function('([p,n])=>chartQA.snapshot().bars.btcusdt?.[p]?.length>=n && chartQA.snapshot().loading["btcusdt:"+p]===false',arg=[period,n],timeout=150000)
    def requests():
        return page.evaluate('chartQA.requests.filter(r=>r.operation==="history")')
    def minutes():
        page.get_by_role('button',name='1分',exact=True).click();wait('1m',4321)
    began=time.monotonic();start();wait('1d',240)
    report['cold_daily_seconds']=round(time.monotonic()-began,2)
    print('Daily history verified',flush=True)
    began=time.monotonic();minutes()
    report['cold_minute_seconds']=round(time.monotonic()-began,2)
    report['cold_requests']=requests()
    report['minute_bars']=page.evaluate('chartQA.snapshot().bars.btcusdt["1m"].length')
    page.screenshot(path=str(root/'cold.png'))
    print('Three-day minute cache verified',report['cold_minute_seconds'],flush=True)
    began=time.monotonic();start();wait('1d',240);minutes()
    report['warm_restart_seconds']=round(time.monotonic()-began,2)
    report['warm_requests']=requests()
    assert all(r['count']<=3 for r in report['warm_requests']),report['warm_requests']
    print('Warm restart only refreshed tail candles',flush=True)
    page.evaluate('''async()=>{const {openDb,idbGetAll,idbPut,KLINE_HISTORY_STORE}=await import('/src/lib/idb.ts');const db=await openDb();const row=(await idbGetAll(db,KLINE_HISTORY_STORE)).find(r=>r.key.startsWith('collection-chart-v1:')&&r.period==='1m');row.bars.splice(100,1);await idbPut(db,KLINE_HISTORY_STORE,row)}''')
    start();wait('1d',240);minutes()
    report['repair_requests']=requests()
    assert any(r['resolution']=='1' and r['count']==1 for r in report['repair_requests'])
    assert all(r['count']<=3 for r in report['repair_requests'])
    print('Interior gap repaired with one candle',flush=True)
    page.route('**/__collection__/edge/data?*',lambda r:r.fulfill(json={'code':503,'msg':'验收模拟网络中断','data':None}))
    start()
    page.get_by_role('alert').wait_for(timeout=60000)
    assert '核对未完成' in page.get_by_role('alert').inner_text()
    page.unroute('**/__collection__/edge/data?*')
    page.get_by_role('button',name='重新核对并加载',exact=True).click();wait('1d',240)
    assert page.get_by_role('alert').count()==0
    report['retry_after_failure']=True
    previous=page.evaluate('chartQA.snapshot().realtime.btcusdt?.["1d"]?.version||0')
    page.wait_for_function('(v)=>(chartQA.snapshot().realtime.btcusdt?.["1d"]?.version||0)>v',arg=previous,timeout=45000)
    report['realtime_after_verification']=True
    assert not errors,errors
    page.screenshot(path=str(root/'verified.png'))
    report['page_errors']=errors
    (root/'browser-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if not k.endswith('requests')},ensure_ascii=True),flush=True)
    browser.close()
