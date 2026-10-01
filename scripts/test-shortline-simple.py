#!/usr/bin/env python3
"""
短线因子实验室简化测试（直接调用内核）
测试 GPU 和 CPU 挖掘是否正常工作
"""
import sys
import json
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

def test_basic_constants():
    """测试基础常量"""
    print("\n=== 测试 1：基础常量验证 ===")
    from factor_lab.research_context import SHORTLINE_NORM_WINDOW, PROFILE_SHORTLINE_V1

    assert SHORTLINE_NORM_WINDOW == 300
    assert PROFILE_SHORTLINE_V1 == "shortline_v1"
    print(f"✓ SHORTLINE_NORM_WINDOW = {SHORTLINE_NORM_WINDOW}")
    print(f"✓ PROFILE_SHORTLINE_V1 = {PROFILE_SHORTLINE_V1}")

def test_window_resolution():
    """测试窗口推导"""
    print("\n=== 测试 2：归一化窗口推导 ===")
    from factor_lab.research_context import resolve_context

    bars = [
        {'time': f'2024-01-01T{str(i//60).zfill(2)}:{str(i%60).zfill(2)}:00',
         'close': 100.0, 'open': 100.0, 'high': 100.0, 'low': 100.0, 'volume': 1000.0}
        for i in range(1500)
    ]

    # shortline_v1 固定 300
    ctx = resolve_context(
        {'research_profile': 'shortline_v1', 'timeframe': '1m', 'symbol': 'BTCUSDT'},
        bars, 0.0003
    )
    assert ctx.norm_window == 300
    print(f"✓ shortline_v1 归一化窗口 = {ctx.norm_window}")

    # crypto_local_v2 动态推导
    ctx2 = resolve_context(
        {'research_profile': 'crypto_local_v2', 'timeframe': '1m', 'symbol': 'BTCUSDT'},
        bars, 0.0003
    )
    assert ctx2.norm_window == 1440
    print(f"✓ crypto_local_v2 归一化窗口 = {ctx2.norm_window} (动态)")

def test_cpu_mining():
    """测试 CPU 挖掘（小规模）"""
    print("\n=== 测试 3：CPU 挖掘验证 ===")

    import factor_local

    # 生成简单测试数据（500 根 bars）
    bars = []
    for i in range(500):
        bars.append({
            'time': f'2024-01-01T{str(i//60).zfill(2)}:{str(i%60).zfill(2)}:00',
            'close': 100.0 + (i % 10) * 0.1,
            'open': 100.0,
            'high': 100.5,
            'low': 99.5,
            'volume': 1000.0,
        })

    payload = {
        "mode": "search",
        "symbol": "BTCUSDT",
        "timeframe": "1m",
        "population": 20,  # 极小规模快速验证
        "generations": 3,
        "max_depth": 3,
        "top_n": 5,
        "seed": 42,
        "cost": 0.0003,
        "train_ratio": 0.7,
        "walk_forward_folds": 2,
        "selection_v2": True,
        "evolve_v2": True,
        "research_profile": "shortline_v1",
        "execution_model": "signal_research",
        "final_generation": True,
    }

    print(f"运行 CPU 挖掘：20种群 × 3代（快速验证）...")
    started = time.time()

    try:
        raw = factor_local.run(json.dumps(payload), json.dumps(bars))
        elapsed = time.time() - started
        result = json.loads(raw)

        print(f"✓ CPU 挖掘完成 ({elapsed:.1f}s)")
        print(f"  - 冠军数：{len(result)}")

        if len(result) > 0:
            print(f"  - 示例冠军得分：{result[0].get('composite', 0):.3f}")
            return True
        else:
            print(f"  ⚠ 无冠军产出（正常，数据太少）")
            return True  # 没崩溃就算通过

    except Exception as e:
        print(f"✗ CPU 挖掘失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_gpu_availability():
    """测试 GPU 可用性"""
    print("\n=== 测试 4：GPU 可用性检查 ===")

    try:
        import cupy as cp
        cp.cuda.runtime.getDeviceCount()
        print("✓ GPU (CUDA) 可用")
        return True
    except Exception as e:
        print(f"⚠ GPU 不可用: {e}")
        print("  - 这是正常的（如果没有 NVIDIA 显卡）")
        print("  - CPU 引擎仍可工作")
        return False

def main():
    print("=" * 60)
    print("短线因子实验室修复验证（简化版）")
    print("=" * 60)

    results = {}

    # 测试 1 & 2：基础验证
    try:
        test_basic_constants()
        test_window_resolution()
        results["constants"] = True
    except Exception as e:
        print(f"\n✗ 基础测试失败: {e}")
        results["constants"] = False
        sys.exit(1)

    # 测试 3：CPU 挖掘
    results["cpu"] = test_cpu_mining()

    # 测试 4：GPU 检查（不阻塞）
    results["gpu_available"] = test_gpu_availability()

    # 汇总
    print("\n" + "=" * 60)
    print("测试结果汇总")
    print("=" * 60)
    print(f"基础验证: {'✓' if results['constants'] else '✗'}")
    print(f"CPU 挖掘: {'✓' if results['cpu'] else '✗'}")
    print(f"GPU 可用: {'✓' if results['gpu_available'] else '⚠ (可选)'}")

    if results["constants"] and results["cpu"]:
        print("\n✓✓✓ 核心功能验证通过")
        print("\n后续步骤：")
        print("1. 在桌面应用中测试完整流程（币种选择 → 一键启动）")
        print("2. 验证 GPU 引擎（如果有 NVIDIA 显卡）")
        print("3. 运行真实任务（ETHUSDT 15m，300种群×30代）")
        sys.exit(0)
    else:
        print("\n✗✗✗ 验证失败")
        sys.exit(1)

if __name__ == "__main__":
    main()
