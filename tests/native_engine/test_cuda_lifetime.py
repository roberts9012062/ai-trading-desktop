"""GC on the WS thread and runtime teardown must retain a valid CUDA context."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class CudaLifetimeTests(unittest.TestCase):
    def test_main_thread_collection_and_cancelled_server_cleanup(self):
        code = r'''
import asyncio, contextlib, gc, io, json, weakref
from engine.server import EngineServer
from engine.runtime import initialize_runtime
from engine.cuda_context import capture_cuda_context
import taichi as ti

async def check():
    initial_gc = gc.isenabled()
    server = EngineServer()
    refs = []
    def allocate_cycle():
        arr = ti.ndarray(ti.i32, shape=16)
        arr.fill(1)
        ti.sync()
        cycle = [arr]
        cycle.append(cycle)
        refs.append(weakref.ref(arr))
    def startup(inject_failure):
        initialize_runtime('mixed', require_cuda=True)
        server.cuda_context = capture_cuda_context()
        allocate_cycle()
        server.hello = {'backend': 'cuda', 'fixture': 'lifetime-only'}
        return server.hello
    server.startup = startup
    output = io.StringIO()
    task = None
    try:
        with contextlib.redirect_stdout(output):
            task = asyncio.create_task(server.run())
            for _ in range(1000):
                if 'native_engine_ready' in output.getvalue():
                    break
                if task.done():
                    await task
                await asyncio.sleep(.01)
            else:
                raise AssertionError('No ready record')
            assert capture_cuda_context() == server.cuda_context
            assert gc.isenabled() == initial_gc
            assert refs[0]() is None  # Startup cycles collected on owner.
            gc.disable()
            await asyncio.get_running_loop().run_in_executor(server.executor, allocate_cycle)
            assert refs[-1]() is not None
            if initial_gc:
                gc.enable()
            gc.collect()
            assert refs[-1]() is None
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        assert gc.isenabled() == initial_gc
        assert ti.lang.impl.get_runtime().prog is None
        print('CUDA_LIFETIME_PASS')
    finally:
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        server.executor.shutdown(wait=True)

asyncio.run(check())
'''
        result = subprocess.run([sys.executable, '-u', '-c', code], cwd=ROOT,
            env={**os.environ, 'PYTHONPATH': str(ROOT/'native-engine'), 'PYTHONIOENCODING': 'utf-8'},
            capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout+'\n'+result.stderr)
        self.assertIn('CUDA_LIFETIME_PASS', result.stdout)


if __name__ == '__main__':
    unittest.main()
