"""Single numerical executor keeps CUDA calls ordered; WS heartbeat stays live."""
import asyncio
import gc
import json
import secrets
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .protocol import MAX_FRAME_BYTES, ProtocolError, decode_message, encode_message


def _trace_dispatch(kind, session_id, payload):
    """诊断追踪:关键请求的摘要追加落盘,供排查「0 合格」类口径问题。

    只记录请求侧摘要(load_bars 根数/mine_features 配置/precise 批次规模),
    不记数值结果、不进 stdout(那是宿主协议通道),失败静默——诊断设施
    绝不影响引擎可用性。
    """
    try:
        from datetime import datetime
        from pathlib import Path
        entry = {"ts": datetime.now().isoformat(timespec="seconds"), "kind": kind, "session": session_id}
        if kind == "load_bars":
            entry["count"] = (payload.get("metadata") or {}).get("count")
        elif kind == "mine_features":
            entry["config"] = payload.get("config")
        elif kind == "precise":
            entry["best_seen"] = len(payload.get("best_seen") or [])
            entry["final"] = payload.get("final_generation")
        elif kind == "strict_eval":
            entry["candidates"] = len(payload.get("candidates") or [])
        path = Path(__file__).resolve().parents[1] / "engine-trace.log"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass


def _trace_precise_result(result):
    """诊断追踪:precise 资格判定摘要(拒因分布与首条 WF 原始结构)。"""
    try:
        from datetime import datetime
        from pathlib import Path
        entry = {"ts": datetime.now().isoformat(timespec="seconds"), "kind": "precise_result",
                 "requirements": result.get("qualification_requirements"),
                 "champions": len(result.get("champions") or []),
                 "rejected": len(result.get("rejected_candidates") or [])}
        rejected = result.get("rejected_candidates") or []
        if rejected:
            metrics = rejected[0].get("metrics") or {}
            entry["first_reject_reasons"] = rejected[0].get("qualification", {}).get("reasons")
            entry["first_walk_forward"] = metrics.get("walk_forward")
            entry["first_holdout"] = {k: v for k, v in (metrics.get("holdout_metrics") or {}).items()
                                      if isinstance(v, (int, float, str, bool, type(None)))}
        path = Path(__file__).resolve().parents[1] / "engine-trace.log"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except Exception:
        pass


class EngineServer:
    def __init__(self, precision="mixed"):
        self.precision = precision
        self.token = secrets.token_urlsafe(32)
        self.sessions = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="native-gpu")
        self.hello = None
        self.cuda_context = None

    def startup(self, inject_failure=False):
        from .runtime import initialize_runtime
        from .selfcheck import run_startup_selfcheck

        def boot(stage, **payload):
            # stdout 启动进度行:ready 之前宿主据此展示预热进度,而不是
            # 静默等待到超时误判「编译失败」。单行 JSON 且不含 token,
            # 与最终的 native_engine_ready 行同构,宿主按行解析即可、
            # 未知类型直接忽略,协议向后兼容。
            print(json.dumps({"type": "native_engine_boot", "stage": stage, **payload}), flush=True)

        runtime = initialize_runtime(self.precision)
        if runtime["backend"] != "cuda":
            raise RuntimeError("Native CUDA unavailable; use existing WebGPU/CPU engine")
        boot("runtime", device=runtime["device_name"], capability=runtime.get("capability"),
             kernel_pathway=runtime.get("kernel_pathway"))
        from .cuda_context import capture_cuda_context
        self.cuda_context = capture_cuda_context()
        # compat 路径(50 系 sm_120 等)kernel 由驱动 JIT 转译,冷缓存首启
        # 预热为十分钟级;native 路径(20/30/40 系)与热缓存都很快
        boot("selfcheck_begin", message="kernel JIT warmup + deterministic selfcheck",
             first_boot_hint=("driver-translated kernels; cold cache first warmup may take tens of minutes"
                              if runtime.get("kernel_pathway") == "compat" else
                              "warm cache makes this fast"))
        check = run_startup_selfcheck(self.precision, inject_failure=inject_failure)
        if not check["passed"]:
            raise RuntimeError("G1 deterministic selfcheck failed; native engine refused")
        boot("selfcheck_done", sha256=check["sha256"])
        self.hello = {**runtime, "precision": self.precision, "selfcheck": check}
        return self.hello

    def dispatch(self, message):
        from .session import NativeSession
        kind, session_id, payload = message["type"], message.get("session_id"), message["payload"]
        _trace_dispatch(kind, session_id, payload)
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
        if kind == "strict_eval":
            candidates = payload.get("candidates")
            if not isinstance(candidates, list) or len(candidates) > 100_000:
                raise ProtocolError("Invalid strict candidate population")
            return {"strict": session.strict_eval(candidates)}
        if kind == "precise":
            for name in ("candidates", "evaluated", "best_seen", "prefetched_strict"):
                values = payload.get(name, [])
                if not isinstance(values, list) or len(values) > 100_000:
                    raise ProtocolError("Invalid precise candidate payload")
            result = session.precise(payload)
            _trace_precise_result(result)
            return result
        raise ProtocolError("Mode not implemented", "UNSUPPORTED_MODE")

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
        from .cuda_context import CudaContextLease
        previous_gc, lease = gc.isenabled(), None
        # No GC may free worker-owned arrays on the event-loop thread until
        # its borrowed CUDA context is current. Restore normal GC after bind.
        gc.disable()
        try:
            await loop.run_in_executor(self.executor, self.startup, inject_failure)
            await loop.run_in_executor(self.executor, gc.collect)
            lease = CudaContextLease(self.cuda_context)
            if previous_gc:
                gc.enable()
            async with serve(self.handle, "127.0.0.1", 0, max_size=MAX_FRAME_BYTES,
                             ping_interval=1, ping_timeout=10, compression=None) as server:
                port = server.sockets[0].getsockname()[1]
                print(json.dumps({"type": "native_engine_ready", "port": port, "token": self.token,
                                  "hello": self.hello}), flush=True)
                await asyncio.Future()
        finally:
            gc.disable()
            try:
                await loop.run_in_executor(self.executor, self.dispose_owned, set(self.sessions))
                await loop.run_in_executor(self.executor, gc.collect)
                if lease is not None:
                    lease.close()
            finally:
                try:
                    if self.cuda_context is not None:
                        # Pop the WS lease before destroying its borrowed
                        # context. Runtime teardown must run on the CUDA owner.
                        import taichi as ti
                        await loop.run_in_executor(self.executor, ti.reset)
                finally:
                    if previous_gc:
                        gc.enable()


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
