"""Explicit backend selection: no silently successful CUDA -> CPU fallback."""
import ctypes
import os

_runtime = None

# Taichi 1.7.4 内嵌 LLVM 15 NVPTX 工具链原生支持的计算能力上限(sm_86)。
# 20/30/40 系(75/86/89)走原生或同代兼容路径;50 系 sm_120 超出工具链支持,
# kernel 产物由 NVIDIA 驱动逐个 JIT 转译,大 f64 kernel 单个可达分钟级——
# 必须依赖持久化 JIT 缓存,否则每次冷启动都重演数十分钟的全量预热。
NATIVE_CAPABILITY_LIMIT = 86


def _writable_cache_root():
    """选择可写的 JIT 缓存根目录:优先引擎目录 cache/,回退 LOCALAPPDATA。

    纯探测:只创建目录与一次性探针文件,失败即换下一个候选。
    安装到 Program Files 等只读位置时自动落到用户目录。
    """
    from pathlib import Path
    candidates = (
        Path(__file__).resolve().parents[1] / "cache",
        Path(os.environ.get("LOCALAPPDATA", ".")) / "ai-trading-desktop-gpu-cache",
    )
    for base in candidates:
        try:
            base.mkdir(parents=True, exist_ok=True)
            probe = base / ".write-probe"
            probe.write_bytes(b"")
            probe.unlink()
            return base
        except OSError:
            continue
    return None


def configure_jit_caches():
    """在 ti.init 与 CUDA 上下文创建之前布置 JIT 缓存环境变量。

    驱动与 Taichi 只在首次初始化时读取这些变量一次,因此本函数必须
    先于 ti.init 调用。全部使用 setdefault:用户显式配置永远优先。
    - CUDA_CACHE_PATH / CUDA_CACHE_MAXSIZE:NVIDIA 驱动 PTX→SASS 转译缓存。
      默认落系统 TEMP 且上限偏小,磁盘清理会吞掉预热成果;固定到引擎
      目录并放大到 4GB(Blackwell 大 kernel 的转译产物可达 GB 级)。
    - TMP / TEMP:Taichi offline cache 落在 GetTempPath()/taichi_cache,
      且 1.7.4 无独立的缓存目录配置项。系统 TEMP 总是已存在,setdefault
      对其无效,因此这里对进程内 TMP/TEMP 做强制重定向(仅本进程,不改
      系统设置);代价是引擎的全部临时文件也落在缓存根下,卸载时一并带走。
    """
    root = _writable_cache_root()
    if root is None:
        return
    (root / "cuda-jit").mkdir(parents=True, exist_ok=True)
    (root / "tmp").mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("CUDA_CACHE_PATH", str(root / "cuda-jit"))
    os.environ.setdefault("CUDA_CACHE_MAXSIZE", "4294967296")
    redirected_tmp = str(root / "tmp")
    os.environ["TMP"] = redirected_tmp
    os.environ["TEMP"] = redirected_tmp


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
        major = ctypes.c_int()
        minor = ctypes.c_int()
        driver.cuDeviceGetName(name, 256, dev)
        driver.cuDeviceTotalMem_v2(ctypes.byref(total), dev)
        driver.cuDeviceGetAttribute(ctypes.byref(sms), 16, dev)
        # CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR/MINOR = 75/76:
        # 用于判断显卡落在内嵌工具链原生路径还是驱动转译路径
        driver.cuDeviceGetAttribute(ctypes.byref(major), 75, dev)
        driver.cuDeviceGetAttribute(ctypes.byref(minor), 76, dev)
        return {"device_name": name.value.decode(), "vram_mb": total.value // (1024 * 1024), "sm_count": sms.value,
                "capability": major.value * 10 + minor.value}
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
    # 缓存环境变量必须先于 import taichi:Taichi 在库加载时即读取
    # GetTempPath 确定 offline cache 位置,晚于此设置 TMP/TEMP 无效
    configure_jit_caches()
    import taichi as ti
    from pathlib import Path
    info = cuda_device_info()
    arch = ti.cuda if info else ti.cpu
    if require_cuda and info is None:
        raise RuntimeError("NVIDIA CUDA driver/device unavailable")
    # offline_cache 显式开启(原实现显式传 False)。注意本机实测的跨启动
    # 加速(特征 kernel 冷编 222s → 热态约 30s)主要来自驱动 SASS 缓存,
    # Taichi offline cache 是额外保障,两者都要求这里不关闭缓存
    ti.init(arch=arch, enable_fallback=False, default_fp=ti.f64, fast_math=False,
            offline_cache=True, device_memory_fraction=0.5)
    actual = ti.lang.impl.current_cfg().arch
    if actual != arch:
        raise RuntimeError("Unexpected compute backend")
    _runtime = {"engine_version": (Path(__file__).parents[1] / "VERSION").read_text().strip(),
                "backend": "cuda" if actual == ti.cuda else "cpu", "fp64_supported": True,
                **(info or {"device_name": "Native CPU", "vram_mb": 0, "sm_count": 0, "capability": 0})}
    # native:内嵌工具链直接产出(20/30/40 系);compat:超出工具链支持、
    # 由驱动 JIT 转译(50 系),首次预热为分钟级,依赖上面布置的持久缓存
    _runtime["kernel_pathway"] = ("native" if _runtime["capability"] <= NATIVE_CAPABILITY_LIMIT else "compat")
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
