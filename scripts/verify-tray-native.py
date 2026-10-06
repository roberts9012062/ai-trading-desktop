"""Windows native tray acceptance test (five minutes hidden).

Build: cargo build --manifest-path src-tauri/Cargo.toml --example tray-smoke
Build UI: pnpm exec vite build --config scripts/tray-vite.config.ts
Then: python scripts/verify-tray-native.py
Only the isolated probe is started and stopped; no accounts or orders are used.
"""
import ctypes, ctypes.wintypes as w, json, os, socket, subprocess, time, urllib.request
import functools, http.server, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent; user32=ctypes.WinDLL('user32',use_last_error=True)
callback_type=ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
user32.EnumWindows.argtypes=[callback_type,w.LPARAM]
user32.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)]
user32.GetClassNameW.argtypes=[w.HWND,w.LPWSTR,ctypes.c_int]
user32.GetWindowTextW.argtypes=[w.HWND,w.LPWSTR,ctypes.c_int]
user32.IsWindowVisible.argtypes=[w.HWND]; user32.IsIconic.argtypes=[w.HWND]
user32.IsZoomed.argtypes=[w.HWND]
user32.GetWindowRect.argtypes=[w.HWND,ctypes.POINTER(w.RECT)]
user32.SendMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM]
user32.SendMessageW.restype=w.LPARAM
user32.PostMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM]
user32.ShowWindow.argtypes=[w.HWND,ctypes.c_int]

def windows(pid):
    found=[]
    @callback_type
    def each(hwnd,unused):
        owner=w.DWORD();user32.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        if owner.value==pid:
            cls=ctypes.create_unicode_buffer(256); title=ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd,cls,256);user32.GetWindowTextW(hwnd,title,256)
            found.append((hwnd,cls.value,title.value))
        return True
    user32.EnumWindows(each,0);return found

def wait_for(predicate,timeout=15):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if predicate():return
        time.sleep(.1)
    raise AssertionError('condition timed out')

sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
fixture=root/'.local-data/tray-fixture'
assert (fixture/'scripts/tray-smoke.html').exists(), 'Build the tray fixture first'
class FixtureHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(FixtureHandler,directory=str(fixture)))
threading.Thread(target=server.serve_forever,daemon=True).start()
env={**os.environ,'TRAY_SMOKE_URL':f'http://127.0.0.1:{server.server_port}/scripts/tray-smoke.html','TRAY_SMOKE_DEBUG_PORT':str(port)}
env['PATH']=str(root/'src-tauri/target/debug/deps')+os.pathsep+env['PATH']
log=(root/'.local-data/tray-smoke-native.log').open('w',encoding='utf8')
process=subprocess.Popen([str(root/'src-tauri/target/debug/examples/tray-smoke.exe')],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
try:
    def ready():
        assert process.poll() is None, f'Probe exited: {process.returncode}'
        try:return bool(json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json',timeout=1)))
        except Exception:return False
    wait_for(ready,45)
    with sync_playwright() as p:
        version=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version'))
        browser=p.chromium.connect_over_cdp(version['webSocketDebuggerUrl'])
        context=browser.contexts[0]
        page=context.pages[0] if context.pages else context.wait_for_event('page')
        page.wait_for_url('**/scripts/tray-smoke.html')
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('requestfailed',lambda request:print('request failed:',request.url,request.failure,flush=True))
        page.on('response',lambda response:print('http failure:',response.status,response.url,flush=True) if response.status>=400 else None)
        cdp=page.context.new_cdp_session(page)
        cdp.send('Network.enable');cdp.send('Network.setCacheDisabled',{'cacheDisabled':True})
        page.reload(wait_until='domcontentloaded')
        page.on('console',lambda message:print('console:',message.type,message.text,flush=True) if message.type in ('warning','error') else None)
        page.wait_for_load_state('domcontentloaded');page.wait_for_timeout(1000)
        print(json.dumps({'url':page.url,'boot':page.evaluate('({probe:!!window.probe,tauri:window.isTauri,text:document.body.innerText.slice(0,400)})'),'errors':errors}),flush=True)
        page.wait_for_function('window.probe && window.isTauri');page.wait_for_timeout(1000)
        own=windows(process.pid)
        main=next(h for h,c,t in own if t=='CyclePilot · 托盘验收')
        tray=next(h for h,c,t in own if c=='tray_icon_app')
        assert user32.IsWindowVisible(main)
        def click_tray():
            assert user32.PostMessageW(tray,6002,0,0x201)
            assert user32.PostMessageW(tray,6002,0,0x202)
            wait_for(lambda:bool(user32.IsWindowVisible(main)) and not user32.IsIconic(main))
        controls=page.get_by_role('banner',name='窗口控制')
        button=controls.get_by_role('button',name='收起到托盘',exact=True)
        minimize=controls.get_by_role('button',name='最小化',exact=True)
        tray_box=button.bounding_box();min_box=minimize.bounding_box()
        assert tray_box and min_box and abs(tray_box['x']+tray_box['width']-min_box['x'])<1
        assert page.get_by_role('dialog').count()==0
        assert page.evaluate('document.documentElement.scrollHeight <= innerHeight')
        controls.get_by_role('button',name='最大化',exact=True).click()
        wait_for(lambda:bool(user32.IsZoomed(main)))
        controls.get_by_role('button',name='还原窗口',exact=True).click()
        wait_for(lambda:not user32.IsZoomed(main))
        # Exercise the actual drag IPC/permission and the title area's double-click.
        # Synthetic CDP mouse events do not send a physical mouse-up to the OS
        # move loop. Cancel only this probe's loop after verifying drag dispatch.
        cancel_drag=threading.Timer(.3,lambda:user32.PostMessageW(main,0x1f,0,0))
        cancel_drag.start()
        page.get_by_test_id('window-drag-region').dispatch_event('mousedown',{'button':0,'detail':1})
        cancel_drag.join(timeout=1)
        page.wait_for_timeout(300)
        assert page.get_by_role('alert').count()==0
        page.get_by_test_id('window-drag-region').dispatch_event('mousedown',{'button':0,'detail':2})
        wait_for(lambda:bool(user32.IsZoomed(main)))
        controls.get_by_role('button',name='还原窗口',exact=True).click()
        wait_for(lambda:not user32.IsZoomed(main))
        rect=w.RECT();user32.GetWindowRect(main,ctypes.byref(rect))
        point=((rect.top+(rect.bottom-rect.top)//2)&0xffff)<<16 | ((rect.left+1)&0xffff)
        assert user32.SendMessageW(main,0x84,0,point)==10, 'Left edge must remain resizable'
        page.wait_for_function('window.probe.closeGuardReady')
        controls.get_by_role('button',name='关闭',exact=True).click()
        page.wait_for_function('window.probe.closeRequests===1')
        assert process.poll() is None and user32.IsWindowVisible(main)
        minimize.click()
        wait_for(lambda:bool(user32.IsIconic(main)));assert user32.IsWindowVisible(main)
        assert page.get_by_role('dialog').count()==0
        click_tray()
        page.screenshot(path=str(root/'.local-data/titlebar-native-ui.png'))
        before=page.evaluate('window.probe');button.click()
        page.wait_for_timeout(500)
        assert page.get_by_role('alert').count()==0, page.get_by_role('alert').inner_text()
        wait_for(lambda:not user32.IsWindowVisible(main));assert process.poll() is None
        started=time.monotonic();before=page.evaluate('window.probe');hidden=page.evaluate('document.hidden')
        duration=int(os.environ.get('TRAY_SMOKE_HIDDEN_SECONDS','300'))
        assert duration>=5
        deadline=started+duration
        while time.monotonic()<deadline:
            time.sleep(min(60,deadline-time.monotonic()))
            current=page.evaluate('window.probe')
            assert process.poll() is None and not user32.IsWindowVisible(main)
            print(json.dumps({'hidden_seconds':round(time.monotonic()-started),'ticks':current['ticks']-before['ticks'],'worker_ticks':current['workerTicks']-before['workerTicks'],'max_timer_gap_ms':round(current['maxGap'],2),'document_hidden':hidden}),flush=True)
        after=page.evaluate('window.probe');elapsed=time.monotonic()-started
        assert after['ticks']-before['ticks'] >= elapsed*8
        assert after['workerTicks']-before['workerTicks'] >= elapsed*8
        assert after['maxGap']<1500
        (root/'.local-data/tray-background-verification.json').write_text(json.dumps({'hidden_seconds':round(elapsed,2),'timer_ticks':after['ticks']-before['ticks'],'worker_ticks':after['workerTicks']-before['workerTicks'],'max_timer_gap_ms':round(after['maxGap'],2)}),encoding='utf8')
        click_tray()
        assert page.evaluate('window.probe.ticks')>=after['ticks']
        # Both hidden and minimized windows restore without creating a new webview.
        button.click();wait_for(lambda:not user32.IsWindowVisible(main));click_tray()
        user32.ShowWindow(main,6);wait_for(lambda:bool(user32.IsIconic(main)));click_tray()
        page.evaluate('window.__TAURI_INTERNALS__.invoke("tray_smoke_remove_icon")')
        button.click();page.get_by_role('alert').filter(has_text='系统托盘初始化失败').wait_for()
        assert user32.IsWindowVisible(main)
        controls.get_by_role('button',name='关闭提示',exact=True).click()
        # Native taskbar / keyboard minimize also bypasses the removed picker.
        user32.PostMessageW(main,0x112,0xf020,0)
        wait_for(lambda:bool(user32.IsIconic(main)))
        user32.ShowWindow(main,9)
        assert not errors,errors
        result={'native_window_hide_restore':True,'win32_tray_left_click_callback':True,'repeat_hide_restore':True,'minimized_restore':True,'hide_error_keeps_window_visible':True,'hidden_seconds':round(elapsed,2),'timer_ticks':after['ticks']-before['ticks'],'worker_ticks':after['workerTicks']-before['workerTicks'],'max_timer_gap_ms':round(after['maxGap'],2),'page_errors':errors,'isolated_from_trading':True}
        result.update(adjacent_tray_minimize_buttons=True,no_minimize_picker=True,normal_minimize=True,native_minimize=True,maximize_restore=True,titlebar_drag_permission=True,titlebar_double_click_maximize=True,edge_resize=True,close_request_guard=True,no_viewport_overflow=True)
        # Only close the isolated probe. The user's running desktop process is untouched.
        page.evaluate('window.probe.preventClose=false')
        with page.expect_event('close',timeout=15000):
            controls.get_by_role('button',name='关闭',exact=True).click()
        process.wait(timeout=15)
        assert not errors, errors
        result.update(confirmed_close_exits=True)
        (root/'.local-data/tray-native-verification.json').write_text(json.dumps(result,indent=2),encoding='utf8')
        print(json.dumps(result),flush=True)
finally:
    if process.poll() is None:process.terminate();process.wait(timeout=15)
    log.close()
    server.shutdown();server.server_close()
