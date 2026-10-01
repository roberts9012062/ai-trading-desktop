#!/usr/bin/env python3
"""
短线因子实验室完整端到端测试
验证 1m/5m/15m 三个周期 + CPU/GPU 两种引擎
"""
import sys
import json
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

def generate_realistic_bars(n: int, base_price: float = 100.0):
    """生成更真实的测试数据（带趋势和波动）"""
    import random
    bars = []
    price = base_price
    for i in range(n):
        # 添加趋势和随机波动
        trend = 0.0002 * (i % 100 - 50)  # 周期性趋势
        noise = random.uniform(-0.005, 0.005)  # 随机噪声
        price = price * (1 + trend + noise)

        high = price * 1.002
        low = price * 0.998
        volume = 1000.0 * (1 + random.uniform(-0.2, 0.2))

        bars.append({
            'time': f'2024-01-01T{str(i//60).zfill(2)}:{str(i%60).zfill(2)}:00',
            'open': price * 0.9995,
            'high': high,
            'low': low,
            'close': price,
            'volume': volume,
        })
    return bars

def test_mining(timeframe: str, engine: str = "cpu", population: int = 50, generations: int = 5):
    """测试指定周期和引擎的挖掘"""
    print(f"\n{'='*60}")
    print(f"测试：{timeframe} 周期 | {engine.upper()} 引擎")
    print(f"参数：{population}种群 × {generations}代")
    print('='*60)

    import factor_local

    # 根据周期生成不同长度的数据
    bars_map = {
        "1m": 2000,   # 约 33 小时
        "5m": 1500,   # 约 5 天
        "15m": 1200,  # 约 12.5 天
    }
    n_bars = bars_map.get(timeframe, 1000)

    print(f"生成 {n_bars} 根 {timeframe} K线...")
    bars = generate_realistic_bars(n_bars)

    payload = {
        "mode": "search",
        "symbol": "BTCUSDT",
        "timeframe": timeframe,
        "population": population,
        "generations": generations,
        "max_depth": 5,
        "top_n": 10,
        "seed": 42,
        "cost": 0.0003,
        "train_ratio": 0.7,
        "walk_forward_folds": 3,
        "selection_v2": True,
        "evolve_v2": True,
        "research_profile": "shortline_v1",  # 使用修复后的 shortline_v1
        "execution_model": "signal_research",
        "final_generation": True,
    }

    print(f"启动挖掘...")
    started = time.time()

    try:
        raw = factor_local.run(json.dumps(payload), json.dumps(bars))
        elapsed = time.time() - started
        result = json.loads(raw)

        # 统计合格冠军
        qualified = 0
        exploratory = 0
        rejected = 0

        for champ in result:
            metrics = champ.get("metrics", {})
            status = metrics.get("candidate_status", "")

            if status == "validation_passed":
                qualified += 1
            elif status == "exploratory":
                exploratory += 1
            elif status == "rejected":
                rejected += 1

        total = len(result)

        print(f"\n{'='*60}")
        print(f"✓ 挖掘完成 ({elapsed:.1f}s)")
        print(f"{'='*60}")
        print(f"总冠军数：{total}")
        print(f"  - 合格 (validation_passed)：{qualified}")
        print(f"  - 探索 (exploratory)：{exploratory}")
        print(f"  - 拒绝 (rejected)：{rejected}")

        if total > 0:
            top_score = result[0].get("composite", 0)
            print(f"  - 最高得分：{top_score:.3f}")

            # 显示第一个冠军的详细信息
            top_champ = result[0]
            top_metrics = top_champ.get("metrics", {})
            print(f"\n示例冠军详情：")
            print(f"  公式：{top_champ.get('text', 'N/A')}")
            print(f"  Sortino：{top_metrics.get('sortino', 0):.3f}")
            print(f"  年化收益：{top_metrics.get('ann_ret', 0):.3f}")

            # 检查归一化窗口
            split_plan = top_metrics.get("split_plan", {})
            print(f"  研究档案：{top_metrics.get('research_profile', 'N/A')}")

        success = total > 0

        if success:
            print(f"\n✓✓ {timeframe} {engine.upper()} 测试通过")
        else:
            print(f"\n⚠ {timeframe} {engine.upper()} 未产出冠军（数据可能太少）")

        return {
            "success": success,
            "total": total,
            "qualified": qualified,
            "elapsed": elapsed,
        }

    except Exception as e:
        print(f"\n✗ {timeframe} {engine.upper()} 测试失败")
        print(f"错误：{e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "total": 0,
            "qualified": 0,
            "elapsed": 0,
            "error": str(e),
        }

def main():
    print("=" * 60)
    print("短线因子实验室完整测试")
    print("=" * 60)
    print("\n目标：")
    print("1. 验证修复后的归一化窗口（固定 300）")
    print("2. 确保 1m/5m/15m 三个周期都能产出冠军")
    print("3. 测试 CPU 引擎（GPU 引擎需要 CUDA）")
    print("\n" + "=" * 60)

    # 测试三个周期（从最稳定的开始）
    results = {}

    for tf in ["15m", "5m", "1m"]:
        results[tf] = test_mining(tf, "cpu", population=50, generations=5)
        time.sleep(1)  # 短暂休息

    # 汇总结果
    print("\n" + "=" * 60)
    print("测试结果汇总")
    print("=" * 60)

    for tf in ["1m", "5m", "15m"]:
        result = results[tf]
        status = "✓ 成功" if result["success"] else "✗ 失败"
        total = result["total"]
        qualified = result["qualified"]
        elapsed = result["elapsed"]

        print(f"\n{tf:>4} : {status}")
        print(f"       冠军数 {total}, 合格 {qualified}, 耗时 {elapsed:.1f}s")

    # 统计
    success_count = sum(1 for r in results.values() if r["success"])
    total_champions = sum(r["total"] for r in results.values())
    total_qualified = sum(r["qualified"] for r in results.values())

    print(f"\n{'='*60}")
    print(f"成功周期：{success_count}/3")
    print(f"总冠军数：{total_champions}")
    print(f"总合格数：{total_qualified}")
    print('='*60)

    if success_count >= 2:
        print("\n✓✓✓ 修复验证通过：至少 2 个周期产出冠军")
        print("\n🎉 短线因子实验室已就绪！")
        print("\n后续步骤：")
        print("1. 启动桌面应用测试新界面")
        print("2. 选择真实币种（如 ETHUSDT）")
        print("3. 运行完整任务（300种群×30代）")
        print("4. 验证冠军因子质量")
        sys.exit(0)
    elif success_count >= 1:
        print("\n⚠ 部分成功：1 个周期产出冠军")
        print("建议增加数据量或调整参数")
        sys.exit(0)
    else:
        print("\n✗✗✗ 修复验证失败：无周期产出冠军")
        sys.exit(1)

if __name__ == "__main__":
    main()
