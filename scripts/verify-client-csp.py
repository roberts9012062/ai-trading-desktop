"""Compiled login, lazy routes, CSP rejection and bundled Pyodide acceptance.

Uses synthetic HTTP only. Never authenticates or contacts an exchange.
"""
import functools,json,threading
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
policy=json.loads((ROOT/'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['app']['security']['csp']
header='; '.join(f'{name} {value}' for name,value in policy.items())
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Content-Security-Policy',header)
        super().end_headers()
    def do_GET(self):
        if not (ROOT/'dist'/self.path.split('?')[0].lstrip('/')).is_file():
            self.path='/index.html'
        super().do_GET()
    def log_message(self,*args):pass

server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(ROOT/'dist')))
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True)
        page=browser.new_page();errors=[];calls=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script("document.addEventListener('securitypolicyviolation',e=>{window.cspViolations=(window.cspViolations||[]).concat(e.violatedDirective)})")
        def network(route):
            if route.request.url.startswith(base+'/api/'):
                calls.append(route.request.method);route.fulfill(status=503,json={'detail':'synthetic offline fixture'})
            elif not route.request.url.startswith(base):route.abort()
            else:route.continue_()
        page.route('**/*',network)
        page.goto(base);page.get_by_role('button',name='登录',exact=True).wait_for()
        # Browser eval is a test-driver operation. The injected DOM script must
        # still be rejected by the real document policy.
        page.evaluate("()=>{const s=document.createElement('script');s.textContent='window.untrustedInlineExecuted=true';document.head.append(s)}")
        page.wait_for_function('(window.cspViolations||[]).includes("script-src-elem")')
        assert page.evaluate('window.untrustedInlineExecuted') is None
        page.get_by_role('link',name='注册账号',exact=True).click()
        page.wait_for_url('**/register')
        page.get_by_role('heading',name='注册账号',exact=True).wait_for()
        page.goto(base+'/login');page.get_by_role('button',name='登录',exact=True).wait_for()
        # Built-in Pyodide uses Emscripten eval; this explicit CSP exception is
        # needed for existing offline research, and does not allow inline JS.
        pyodide=page.evaluate("""async()=>{
          const {loadPyodide}=await import('/pyodide/pyodide.mjs');
          const runtime=await loadPyodide({indexURL:'/pyodide/'});
          return runtime.runPython('sum(range(10))');
        }""")
        assert pyodide==45
        assert not errors,errors
        assert not any(method!='GET' for method in calls),calls
        folder=ROOT/'.local-data/project-audit-2026-11-02'
        page.screenshot(path=str(folder/'compiled-login-csp.png'))
        report=dict(compiled_login=True,lazy_register_route=True,inline_script_rejected=True,bundled_pyodide_result=pyodide,
                    page_errors=errors,financial_requests=0,policy=policy)
        (folder/'csp-browser-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False));browser.close()
finally:server.shutdown();server.server_close()
