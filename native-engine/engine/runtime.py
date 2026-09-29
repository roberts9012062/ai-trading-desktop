"""Explicit backend selection: no silently successful CUDA -> CPU fallback."""
import ctypes
import os

_runtime = None


def cuda_device_info():
    try:
        driver = ctypes.WinDLL("nvcuda.dll") if os.name == "nt" else ctypes.CDLL("libcuda.so.1")
        if driver.cuInit(0) != 0:
            return None
        dev = ctypes.c_int()
        if driver.cuDeviceGet(ctypes.byref(dev), 0) != 0:
            return None
        name = ctypes.create_string_buffer(256)
        total = ctypes.c_size_t()
        sms = ctypes.c_int()
        driver.cuDeviceGetName(name, 256, dev)
        driver.cuDeviceTotalMem_v2(ctypes.byref(total), dev)
        driver.cuDeviceGetAttribute(ctypes.byref(sms), 16, dev)
        return {"device_name": name.value.decode(), "vram_mb": total.value // (1024 * 1024), "sm_count": sms.value}
    except (OSError, AttributeError):
        return None


def initialize_runtime(precision="mixed", *, require_cuda=False):
    global _runtime
    if precision not in ("mixed", "f64"):
        raise ValueError("Unsupported precision")
    if _runtime is not None:
        if require_cuda and _runtime["backend"] != "cuda":
            raise RuntimeError("CUDA unavailable")
        return dict(_runtime)
    import taichi as ti
    from pathlib import Path
    info = cuda_device_info()
    arch = ti.cuda if info else ti.cpu
    if require_cuda and info is None:
        raise RuntimeError("NVIDIA CUDA driver/device unavailable")
    ti.init(arch=arch, enable_fallback=False, default_fp=ti.f64, fast_math=False,
            offline_cache=False, device_memory_fraction=0.5)
    actual = ti.lang.impl.current_cfg().arch
    if actual != arch:
        raise RuntimeError("Unexpected compute backend")
    _runtime = {"engine_version": (Path(__file__).parents[1] / "VERSION").read_text().strip(),
                "backend": "cuda" if actual == ti.cuda else "cpu", "fp64_supported": True,
                **(info or {"device_name": "Native CPU", "vram_mb": 0, "sm_count": 0})}
    return dict(_runtime)


def plan_tile(T, F, population, precision, vram_mb, *, static_bytes=0):
    if T < 2 or not 1 <= F <= 64 or population < 1 or precision not in ("mixed", "f64"):
        raise ValueError("Invalid evaluation dimensions")
    # Authoritative f64: stack 9, factor 1, prefix 4. Mixed additionally
    # reserves a separate f32 stack 9 + f64 factor and feature matrix.
    # Metric position/PnL/turnover cache plus close/input overhead.
    coarse = precision == "mixed"
    per = T * (14 * 8 + 4 * 8 + (9 * 4 + 8 + 2 * 4 if coarse else 0)) + 32 * 4 + 8192
    # Approved instruction grid metadata/statistics for both resident VMs.
    per += (32 * 7 * 4 + 2 * 8) * (2 if coarse else 1)
    feature_bytes = F * T * (8 + (4 if coarse else 0))
    budget = int(vram_mb * 1024 * 1024 * .60) - static_bytes - feature_bytes
    tile = min(population, 128, budget // per)
    if tile < 1:
        raise MemoryError("GPU budget cannot fit one candidate; reduce the bar range or use CPU")
    return tile
