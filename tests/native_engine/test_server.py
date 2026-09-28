"""Real sidecar handshake, authentication, binary bars, eval and disposal."""
import asyncio
import json
import os
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-engine"))
from engine.protocol import decode_message, encode_message
from engine.server import EngineServer
from websockets.asyncio.server import serve


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_startup_selfcheck_never_publishes_ready(self):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "native-engine")}
        proc = await asyncio.create_subprocess_exec(sys.executable, "-m", "engine", "--inject-selfcheck-failure",
                                                  env=env, cwd=ROOT, stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), 180)
            self.assertNotEqual(proc.returncode, 0)
            self.assertNotIn(b'native_engine_ready', out)
            self.assertIn(b'G1 deterministic selfcheck failed', err)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    async def test_heartbeat_remains_live_during_blocked_numerical_execution(self):
        engine = EngineServer()
        engine.hello = {"test": True}
        release, entered = threading.Event(), threading.Event()
        def blocking_dispatch(message):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test executor was not released")
            return {"evaluated": []}
        engine.dispatch = blocking_dispatch
        try:
            async with serve(engine.handle, "127.0.0.1", 0) as server:
                async with connect(f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}') as ws:
                    await ws.send(encode_message("hello", "hello", "", {}, engine.token))
                    await ws.recv()
                    await ws.send(encode_message("eval_shards", "eval", "s", {}, engine.token))
                    self.assertEqual(decode_message(await ws.recv(), engine.token)["type"], "stage")
                    self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                    await ws.send(encode_message("heartbeat", "beat", "", {}, engine.token))
                    response = decode_message(await asyncio.wait_for(ws.recv(), 1), engine.token)
                    self.assertEqual(response["request_id"], "beat")
                    self.assertEqual(response["payload"], {"alive": True})
                    release.set()
                    self.assertEqual(decode_message(await ws.recv(), engine.token)["request_id"], "eval")
        finally:
            release.set()
            engine.executor.shutdown(wait=True)

    async def test_real_sidecar_protocol_and_failed_auth(self):
        env = {**os.environ, "PYTHONPATH": str(ROOT / "native-engine")}
        proc = await asyncio.create_subprocess_exec(sys.executable, "-m", "engine", "--precision", "f64",
                                                  env=env, cwd=ROOT, stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.DEVNULL)
        try:
            endpoint = None
            for _ in range(50):
                line = await asyncio.wait_for(proc.stdout.readline(), 90)
                if not line:
                    self.fail("Sidecar exited before ready")
                try:
                    value = json.loads(line)
                    if value.get("type") == "native_engine_ready":
                        endpoint = value
                        break
                except ValueError:
                    pass
            self.assertIsNotNone(endpoint)
            self.assertTrue(endpoint["hello"]["selfcheck"]["passed"])
            url = f'ws://127.0.0.1:{endpoint["port"]}'
            token = endpoint["token"]
            async with connect(url) as bad:
                await bad.send(encode_message("hello", "bad", "", {}, "wrong"))
                with self.assertRaises(ConnectionClosed):
                    await bad.recv()
            async with connect(url) as ws:
                async def rpc(kind, payload, binary=False):
                    await ws.send(encode_message(kind, kind, "session", payload, token, binary=binary))
                    while True:
                        response = decode_message(await ws.recv(), token)
                        if response["type"] != "stage":
                            self.assertNotEqual(response["type"], "error", response["payload"])
                            return response["payload"]
                await rpc("hello", {})
                count = 420
                start = datetime(2025, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
                x = np.arange(count)
                columns = {"time_idx": start + x * 3600000, "open": 100 + np.sin(x / 13),
                           "high": 102 + np.sin(x / 13), "low": 98 + np.sin(x / 13),
                           "close": 100 + np.sin(x / 13), "volume": 1000 + x % 19}
                await rpc("load_bars", {"columns": {k: np.asarray(v, dtype="<f8").tobytes() for k, v in columns.items()},
                                        "metadata": {"count": count, "max_bars": 100_000}}, True)
                await rpc("mine_features", {"config": {"symbol": "ETHUSDT", "timeframe": "60m", "crypto_profile": True,
                                                        "cost": .0003, "train_ratio": .7}})
                result = await rpc("eval_shards", {"candidates": [[0], [1], [0, 1, 65]]})
                self.assertTrue(result["evaluated"])
                await rpc("dispose_session", {})
                await rpc("dispose_session", {})
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()


if __name__ == "__main__":
    unittest.main()
