from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1100})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/fonts.googleapis.com/**',lambda route:route.abort())
    page.route('**/fonts.gstatic.com/**',lambda route:route.abort())
    page.goto('http://127.0.0.1:5173/scripts/collection-dashboard-preview.html',wait_until='commit')
    page.wait_for_function('window.previewReady===true',timeout=90000)
    page.get_by_text('25,000.00',exact=True).first.wait_for(timeout=60000)
    page.get_by_text('API VALUE COLLECTION · 账户账单',exact=True).wait_for(timeout=60000)
    page.get_by_role('button',name='测试连通',exact=True).click()
    page.get_by_text('已连通',exact=True).wait_for(timeout=30000)
    page.screenshot(path='.local-data/dashboard-collection-connected.png',full_page=True)
    paths=page.evaluate('centerPaths')
    for required in ['/api/v5/account/balance','/api/v5/account/positions','/api/v5/trade/orders-history','/api/v5/account/bills']:
        assert required in paths,paths
    assert '/api/market/channel-status' not in page.evaluate('businessPaths')
    assert '/api/market/signals' not in page.evaluate('businessPaths')
    page.evaluate('disablePrivate()')
    page.get_by_role('button',name='测试连通',exact=True).click()
    page.get_by_text('API VALUE COLLECTION Key 未开通交易所账户接口权限',exact=True).wait_for(timeout=30000)
    page.screenshot(path='.local-data/dashboard-collection-no-permission.png',full_page=True)
    assert not errors,errors
    print('PASS: dashboard quote/account/positions/orders/PnL use center transport; exchange connection test and missing permissions; no legacy channel/signal endpoints or page errors')
    browser.close()
