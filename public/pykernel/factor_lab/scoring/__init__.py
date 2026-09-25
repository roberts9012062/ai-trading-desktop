"""因子评估打分 —— 年化基数、交易成本、多目标评分、A/B 对比

与表达式内核（features / ops / vm / express / search）分离：
内核负责「因子长什么样」，本包负责「因子值多少分」。

本文件不做再导出：features.py 需要 scoring.periods 的交易日统计，
若此处 re-export ab_compare（它又依赖 ..features）会形成循环导入。
一律从具体子模块导入。
"""

from __future__ import annotations
