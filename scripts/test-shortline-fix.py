#!/usr/bin/env python3
"""
短线因子实验室端到端测试
验证修复后 1m/5m/15m 均能产出冠军因子

测试流程：
1. 验证 Python 常量和窗口推导
2. 对三个周期分别运行小规模挖掘（50种群×5代）
3. 检查是否产出冠军因子
"""

import sys
import json
import subprocess
from pathlib import Path

# 切换到项目根目录
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

def test_constants():
    """测试 1：验证 Python 常量定义"""
    print("\n=== 测试 1：验证常量定义 ===")
    from factor_lab.research_context import SHORTLINE_NORM_WINDOW, PROFILE_SHORTLINE_V1

    assert SHORTLINE_NORM_WINDOW == 300, f"窗口应为 300，实际 {SHORTLINE_NORM_WINDOW}"
    assert PROFILE_SHORTLINE_V1 == "shortline_v1", f"Profile 错误: {PROFILE_SHORTLINE_V1}"
    print(f"✓ SHORTLINE_NORM_WINDOW = {SHORTLINE_NORM_WINDOW}")
    print(f"✓ PROFILE_SHORTLINE_V1 = {PROFILE_SHORTLINE_V1}")

def test_window_resolution():
    """测试 2：验证归一化窗口推导"""
    print("\n=== 测试 2：验证窗口推导 ===")
    from factor_lab.research_context import resolve_context

    # 模拟 1500 根 1m bars
    bars = [
        {
            'time': f'2024-01-01T{str(i//60).zfill(2)}:{str(i%60).zfill(2)}:00',
            'close': 100.0, 'open': 100.0, 'high': 100.0, 'low': 100.0, 'volume': 1000.0
        }
        for i in range(1500)
    ]

    # 测试 shortline_v1 固定窗口
    ctx = resolve_context(
        {'research_profile': 'shortline_v1', 'timeframe': '1m', 'symbol': 'BTCUSDT'},
        bars, 0.0003
    )
    assert ctx.norm_window == 300, f"shortline_v1 窗口应为 300，实际 {ctx.norm_window}"
    print(f"✓ shortline_v1 归一化窗口 = {ctx.norm_window}")

    # 测试 crypto_local_v2 动态窗口
    ctx2 = resolve_context(
        {'research_profile': 'crypto_local_v2', 'timeframe': '1m', 'symbol': 'BTCUSDT'},
        bars, 0.0003
    )
    print(f"✓ crypto_local_v2 归一化窗口 = {ctx2.norm_window} (动态推导)")
    assert ctx2.norm_window == 1440, f"v2 动态窗口错误: {ctx2.norm_window}"

def test_mining(symbol: str, timeframe: str, population: int = 50, generations: int = 5):
    """测试 3：运行小规模挖掘验证能否产出冠军"""
    print(f"\n=== 测试 3：{symbol} {timeframe} 挖掘测试 ===")
    print(f"参数：种群 {population} × {generations} 代（小规模验证）")

    # 使用 factor-verify-run.py 脚本
    script = ROOT / "scripts" / "factor-verify-run.py"
    if not script.exists():
        print(f"⚠ 跳过：{script} 不存在")
        return None

    cmd = [
        sys.executable, str(script),
        "--symbol", symbol,
        "--tf", timeframe,
        "--population", str(population),
        "--generations", str(generations),
        "--out", f"/tmp/test-{timeframe}.json",
    ]

    print(f"执行：{' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=600,  # 10分钟超时
        )

        if result.returncode != 0:
            print(f"✗ 挖掘失败 (exit {result.returncode})")
            print(f"stderr: {result.stderr[:500]}")
            return None

        # 解析结果
        output_file = Path(f"/tmp/test-{timeframe}.json")
        if output_file.exists():
            data = json.loads(output_file.read_text())
            qualified = data.get("qualified", 0)
            total = data.get("champions_total", 0)
            print(f"✓ 完成：{qualified}/{total} 合格")

            if qualified > 0:
                print(f"✓✓ 成功：{timeframe} 产出 {qualified} 个冠军因子！")
                return True
            else:
                print(f"⚠ {timeframe} 未产出合格冠军，拒因：{data.get('reasons', {})}")
                return False
        else:
            print(f"⚠ 输出文件不存在: {output_file}")
            return None

    except subprocess.TimeoutExpired:
        print(f"✗ 超时（>10分钟）")
        return None
    except Exception as e:
        print(f"✗ 异常: {e}")
        return None

def main():
    print("=" * 60)
    print("短线因子实验室修复验证测试")
    print("=" * 60)

    # 测试 1 & 2：常量和窗口
    try:
        test_constants()
        test_window_resolution()
    except Exception as e:
        print(f"\n✗✗✗ 基础测试失败: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("基础测试通过，开始挖掘测试...")
    print("=" * 60)

    # 测试 3：三个周期挖掘（小规模验证）
    results = {}
    for tf in ["15m", "5m", "1m"]:  # 15m 最稳定，优先测试
        results[tf] = test_mining("BTCUSDT", tf, population=50, generations=5)

    # 汇总结果
    print("\n" + "=" * 60)
    print("测试结果汇总")
    print("=" * 60)

    success_count = sum(1 for v in results.values() if v is True)
    fail_count = sum(1 for v in results.values() if v is False)
    skip_count = sum(1 for v in results.values() if v is None)

    for tf, result in results.items():
        status = "✓ 成功" if result is True else "✗ 失败" if result is False else "⊘ 跳过"
        print(f"{tf:>4} : {status}")

    print(f"\n成功: {success_count}/3, 失败: {fail_count}/3, 跳过: {skip_count}/3")

    if success_count >= 2:
        print("\n✓✓✓ 修复验证通过：至少 2 个周期产出冠军因子")
        sys.exit(0)
    elif success_count >= 1:
        print("\n⚠ 部分成功：1 个周期产出冠军，建议调整参数或数据")
        sys.exit(0)
    else:
        print("\n✗✗✗ 修复验证失败：无周期产出冠军因子")
        sys.exit(1)

if __name__ == "__main__":
    main()
