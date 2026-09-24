"""Pyodide 入口:JSON 进、JSON 出。worker 把本目录文件写入虚拟 FS 后调用。"""

from __future__ import annotations

import json

from runner_local import run_backtest_local


def run(payload_json: str, bars_json: str) -> str:
    payload = json.loads(payload_json)
    bars = json.loads(bars_json)
    report = run_backtest_local(payload, bars)
    return json.dumps(report, ensure_ascii=False, default=str)


def kernel_version() -> str:
    return "pykernel-2026-08-21.1"
