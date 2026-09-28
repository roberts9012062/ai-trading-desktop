"""Single numerical executor keeps CUDA calls ordered; WS heartbeat stays live."""
import asyncio
import json
import secrets
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .protocol import MAX_FRAME_BYTES, ProtocolError, decode_message, encode_message


class EngineServer:
    def __init__(self, precision="mixed"):
        self.precision = precision
        self.token = secrets.token_urlsafe(32)
        self.sessions = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="native-gpu")
        self.hello = None

    def startup(self, inject_failure=False):
        from .runtime import initialize_runtime
        from .selfcheck import run_startup_selfcheck
        runtime = initialize_runtime(self.precision)
        if runtime["backend"] != "cuda":
            raise RuntimeError("Native CUDA unavailable; use existing WebGPU/CPU engine")
        check = run_startup_selfcheck(self.precision, inject_failure=inject_failure)
        if not check["passed"]:
            raise RuntimeError("G1 deterministic selfcheck failed; native engine refused")
        self.hello = {**runtime, "precision": self.precision, "selfcheck": check}
        return self.hello

    def dispatch(self, message):
        from .session import NativeSession
        kind, session_id, payload = message["type"], message.get("session_id"), message["payload"]
        if kind == "dispose_session":
            session = self.sessions.pop(session_id, None)
            if session:
                session.dispose()
            return {"disposed": True}
        if not isinstance(session_id, str) or not session_id:
            raise ProtocolError("Missing session_id")
        if kind == "load_bars":
            if session_id in self.sessions:
                raise ProtocolError("Task-frozen session already exists")
            if self.sessions:
                raise ProtocolError("M1 allows one resident session; dispose the previous session", "ENGINE_BUSY")
            session = NativeSession(session_id, self.hello, self.precision)
            session.load_bars(payload.get("columns"), payload.get("metadata", {}))
            self.sessions[session_id] = session
            return {"loaded": True, "count": len(session.bars)}
        session = self.sessions.get(session_id)
        if not session:
            raise ProtocolError("Session missing; restart task", "SESSION_MISSING")
        if kind == "mine_features":
            return session.prepare_features(payload.get("config", {}))
        if kind == "eval_shards":
            candidates = payload.get("candidates")
            if not isinstance(candidates, list) or len(candidates) > 100_000:
                raise ProtocolError("Invalid candidate population")
            if payload.get("coarse") is True:
                return {"ranked": session.rank_shards(candidates)}
            return {"evaluated": session.eval_shards(candidates)}
        raise ProtocolError("Mode not implemented by M1", "UNSUPPORTED_MODE")

    def dispose_owned(self, ids):
        for session_id in ids:
            session = self.sessions.pop(session_id, None)
            if session:
                session.dispose()

    async def handle(self, ws):
        tasks, owned = set(), set()
        send_lock = asyncio.Lock()

        async def send(kind, message, payload, binary=False):
            async with send_lock:
                await ws.send(encode_message(kind, message.get("request_id"), message.get("session_id"), payload,
                                             self.token, binary=binary))

        async def process(message):
            kind = message["type"]
            try:
                if kind == "hello":
                    await send("hello", message, self.hello)
                elif kind == "heartbeat":
                    await send("heartbeat", message, {"alive": True})
                else:
                    await send("stage", message, {"message": kind})
                    result = await asyncio.get_running_loop().run_in_executor(self.executor, self.dispatch, message)
                    if kind == "load_bars":
                        owned.add(message["session_id"])
                    elif kind == "dispose_session":
                        owned.discard(message.get("session_id"))
                    await send(kind, message, result, binary=kind == "eval_shards")
            except ConnectionClosed:
                pass
            except Exception as exc:
                try:
                    await send("error", message, {"code": getattr(exc, "code", "ENGINE_ERROR"),
                               "message": str(exc), "traceback_tail": traceback.format_exc().splitlines()[-6:]})
                except ConnectionClosed:
                    pass

        try:
            # Never disclose the stdout token to an unauthenticated connection.
            first = decode_message(await asyncio.wait_for(ws.recv(), 5), self.token)
            await process(first)
            async for frame in ws:
                message = decode_message(frame, self.token)
                if len(tasks) >= 16:
                    raise ProtocolError("Too many pending requests")
                task = asyncio.create_task(process(message))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        except (ProtocolError, asyncio.TimeoutError):
            await ws.close(code=4003, reason="Authorization or protocol failure")
        except ConnectionClosed:
            pass
        finally:
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.get_running_loop().run_in_executor(self.executor, self.dispose_owned, owned)

    async def run(self, *, inject_failure=False):
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self.executor, self.startup, inject_failure)
        async with serve(self.handle, "127.0.0.1", 0, max_size=MAX_FRAME_BYTES,
                         ping_interval=1, ping_timeout=10, compression=None) as server:
            port = server.sockets[0].getsockname()[1]
            print(json.dumps({"type": "native_engine_ready", "port": port, "token": self.token,
                              "hello": self.hello}), flush=True)
            try:
                await asyncio.Future()
            finally:
                await loop.run_in_executor(self.executor, self.dispose_owned, set(self.sessions))


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--precision", choices=("mixed", "f64"), default="mixed")
    # Fault injection is confined to the developer process invocation.
    p.add_argument("--inject-selfcheck-failure", action="store_true")
    args = p.parse_args()
    server = EngineServer(args.precision)
    try:
        asyncio.run(server.run(inject_failure=args.inject_selfcheck_failure))
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(json.dumps({"type": "native_engine_error", "code": "STARTUP_FAILED", "message": str(exc)}), file=sys.stderr, flush=True)
        return 1
    finally:
        server.executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    raise SystemExit(main())
