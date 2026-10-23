import os,json,time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 browser=p.chromium.launch(channel='msedge',headless=True)
 page=browser.new_page(viewport={'width':1400,'height':900})
 errors=[];warnings=[]
 page.on('pageerror',lambda e:(errors.append(str(e)),print('PAGE ERROR:',str(e),flush=True)))
 page.on('console',lambda m:print('CONSOLE ERROR:',m.text,flush=True) if m.type=='error' else None)
 page.on('console',lambda m:warnings.append(m.text) if m.type=='warning' else None)
 page.route('**/api/**',lambda r:r.continue_() if '/__collection__/' in r.request.url else r.fulfill(json={'code':200,'data':[]}))
 page.route('**/fonts.googleapis.com/**',lambda r:r.abort())
 page.route('**/fonts.gstatic.com/**',lambda r:r.abort())
 page.goto(os.environ.get('COLLECTION_PREVIEW_URL','http://127.0.0.1:5173/scripts/collection-chart-preview.html'),wait_until='commit',timeout=60000)
 page.wait_for_function('!!window.chartQA',timeout=120000)
 started=time.monotonic();assert page.evaluate('(key)=>chartQA.start(key)',os.environ['COLLECTION_LIVE_KEY'])==60
 page.wait_for_function('chartQA.snapshot().bars.btcusdt?.["1d"]?.length>=200',timeout=60000)
 first=round(time.monotonic()-started,2)
 page.wait_for_function('chartQA.frames()>=3',timeout=45000)
 snap=page.evaluate('chartQA.snapshot()');first_version=snap['realtime']['btcusdt']['1d']['version']
 page.wait_for_function('(v)=>chartQA.snapshot().realtime.btcusdt["1d"].version>v',arg=first_version,timeout=30000)
 page.screenshot(path='.local-data/chart-live-btc.png')
 print('BTC first render seconds:',first,'live frames:',page.evaluate('chartQA.frames()'),flush=True)
 print('Buttons:',page.get_by_role('button').all_text_contents()[:12],flush=True)
 for symbol in ['ethusdt','solusdt','btcusdt']:
  start=time.monotonic();page.evaluate('(s)=>chartQA.select(s)',symbol)
  page.wait_for_function('(s)=>chartQA.snapshot().bars[s]?.["1d"]?.length>=200',arg=symbol,timeout=60000)
  page.wait_for_function('(s)=>chartQA.snapshot().realtime[s]?.["1d"]?.version>Date.now()-10000',arg=symbol,timeout=45000)
  print(symbol,'switch seconds:',round(time.monotonic()-start,2),flush=True)
 page.get_by_role('button',name='1分',exact=True).click()
 page.wait_for_function('chartQA.snapshot().bars.btcusdt?.["1m"]?.length>=200',timeout=60000)
 page.wait_for_function('chartQA.snapshot().realtime.btcusdt?.["1m"]?.version>Date.now()-10000',timeout=45000)
 # Keep the actual mounted chart running across a 45-second ticket renewal.
 previous_time=page.evaluate('chartQA.snapshot().realtime.btcusdt["1m"].time')
 page.wait_for_timeout(70000)
 assert page.evaluate('chartQA.snapshot().realtime.btcusdt["1m"].time')!=previous_time
 assert page.evaluate('chartQA.snapshot().realtime.btcusdt["1m"].version>Date.now()-10000')
 page.screenshot(path='.local-data/chart-live-renewed.png')
 print('History requests:',json.dumps([r for r in page.evaluate('chartQA.requests') if r['operation']=='history']),flush=True)
 assert not errors,errors
 histories=[r for r in page.evaluate('chartQA.requests') if r['operation']=='history']
 assert all(1<=r['count']<=500 for r in histories),'Unbounded history request'
 assert {(r['symbol'],r['resolution']) for r in histories}=={('BTC-USDT-SWAP','1D'),('ETH-USDT-SWAP','1D'),('SOL-USDT-SWAP','1D'),('BTC-USDT-SWAP','1')},'Unexpected background history fan-out'
 assert len(page.evaluate('chartQA.snapshot().bars.btcusdt["1m"]'))>=4321,'Three-day minute cache was not verified'
 assert not [m for m in warnings if 'K线实时更新失败' in m],warnings
 print('PASS actual chart: 60 contracts, three-day minute cache, repeated dynamic updates, 3 symbol switches, period switch, ticket renewal, no page errors',flush=True)
 browser.close()
