"""Validate desktop official perpetual bars. Never fetch or fall back to market APIs."""
from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta
from typing import Any

from crypto_bt_data import WARMUP_BARS

TF_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "240m": 240, "1d": 1440}


def validate_desktop_history(payload: dict[str, Any], expected_tf: str) -> list[dict[str, Any]] | None:
    fields = ("history_source", "history_timeframe", "history_bars")
    if not any(payload.get(k) is not None for k in fields):
        return None  # Older clients retain the existing path.
    sources = {"okx": "okx_archive_v1", "binance_usdt": "binance_um_archive_v1"}
    if payload.get("data_channel") not in sources or payload.get("history_source") != sources[payload["data_channel"]]:
        raise ValueError("本机回测数据来源必须匹配 OKX / Binance 永续官方归档")
    if payload.get("history_timeframe") != expected_tf or expected_tf not in TF_MINUTES:
        raise ValueError("本机回测数据周期与策略所需周期不一致")
    rows = payload.get("history_bars")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 200000:
        raise ValueError("本机回测数据为空或超过20万根")
    step = timedelta(minutes=TF_MINUTES[expected_tf])
    previous: datetime | None = None
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            stamp = str(row["time"])
            dt = datetime.fromisoformat(stamp)
            if dt.tzinfo is not None or len(stamp) not in (10, 19):
                raise ValueError("timestamp")
            values = {k: float(row[k]) for k in ("open", "high", "low", "close", "volume")}
            if not all(math.isfinite(v) for v in values.values()) or values["volume"] < 0:
                raise ValueError("number")
            if min(values[k] for k in ("open", "high", "low", "close")) <= 0 or not (
                values["low"] <= min(values["open"], values["close"]) <= max(values["open"], values["close"]) <= values["high"]
            ):
                raise ValueError("OHLC")
            if dt.second or (dt.hour * 60 + dt.minute) % TF_MINUTES[expected_tf]:
                raise ValueError("alignment")
            if previous is not None and dt - previous != step:
                raise ValueError("gap/order")
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            raise ValueError("本机 K 线格式、价格或连续性校验失败，请重新下载或缩短区间") from exc
        previous = dt
        out.append({"time": stamp, **values})
    return out


def slice_desktop_history(bars: list[dict[str, Any]], timeframe: str, start: date, end: date, warmup_bars: int = WARMUP_BARS) -> list[dict[str, Any]]:
    first = datetime.combine(start, time.min)
    last = datetime.combine(end + timedelta(days=1), time.min) - timedelta(minutes=TF_MINUTES[timeframe])
    if datetime.fromisoformat(bars[0]["time"]) > first or datetime.fromisoformat(bars[-1]["time"]) < last:
        raise ValueError("本机数据未覆盖完整回测区间，请选择已发布且完整的历史区间")
    begin = next(i for i, b in enumerate(bars) if datetime.fromisoformat(b["time"]) >= first)
    return [b for b in bars[max(0, begin-warmup_bars):] if datetime.fromisoformat(b["time"]) <= last]
