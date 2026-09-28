"""Authenticated JSON/msgpack envelopes; numeric columns are little-endian f64."""
import hmac
import json

import msgpack
import numpy as np

MAX_FRAME_BYTES = 64 * 1024 * 1024


class ProtocolError(ValueError):
    def __init__(self, message, code="INVALID_REQUEST"):
        super().__init__(message)
        self.code = code


def encode_message(kind, request_id, session_id, payload, token, *, binary=False):
    envelope = {"type": kind, "request_id": request_id, "session_id": session_id,
                "Authorization": "Bearer " + token, "payload": payload}
    return msgpack.packb(envelope, use_bin_type=True) if binary else json.dumps(envelope, allow_nan=False)


def decode_message(frame, token):
    if len(frame) > MAX_FRAME_BYTES:
        raise ProtocolError("Message exceeds 64 MiB", "FRAME_TOO_LARGE")
    try:
        value = json.loads(frame) if isinstance(frame, str) else msgpack.unpackb(frame, raw=False, strict_map_key=True)
    except (ValueError, msgpack.UnpackException) as exc:
        raise ProtocolError("Malformed message") from exc
    if not isinstance(value, dict):
        raise ProtocolError("Expected message envelope")
    auth = value.get("Authorization", "")
    if not isinstance(auth, str) or not hmac.compare_digest(auth, "Bearer " + token):
        raise ProtocolError("Invalid local engine authorization", "UNAUTHORIZED")
    if not isinstance(value.get("type"), str) or not isinstance(value.get("payload"), dict):
        raise ProtocolError("Missing type/payload")
    return value


def decode_columns(columns, count, max_bars):
    if max_bars not in (100_000, 200_000, 300_000):
        raise ProtocolError("Invalid device-profile bar limit")
    if not isinstance(count, int) or isinstance(count, bool) or count < 2 or count > max_bars:
        raise ProtocolError(f"Bar count exceeds device tier limit {max_bars}", "BAR_LIMIT")
    if not isinstance(columns, dict) or not columns:
        raise ProtocolError("Empty bar columns")
    result = {}
    for name, data in columns.items():
        if not isinstance(name, str) or not isinstance(data, bytes) or len(data) != count * 8:
            raise ProtocolError("Column shape/dtype mismatch")
        result[name] = np.frombuffer(data, dtype="<f8").copy()
    return result
