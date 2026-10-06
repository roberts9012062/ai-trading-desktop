"""Export the server's pure factor replay into the desktop Worker.

Only networking, async scheduling and unrelated strategy branches are removed.
The accounting and replay rules remain the server implementation.
Run: python scripts/export-factor-backtest.py <server backend/app directory>
"""
import ast
import hashlib
import sys
from pathlib import Path

app = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[1] / "public/pykernel"
source = (app / "services/backtest/runner.py").read_text(encoding="utf8")


def static(node):
    if isinstance(node, ast.BoolOp):
        values = [static(value) for value in node.values]
        if isinstance(node.op, ast.And) and False in values:
            return False
        if isinstance(node.op, ast.Or) and True in values:
            return True
        if None in values:
            return None
    try:
        # Only literal expressions after specializing strategy_type are folded.
        if any(isinstance(n, (ast.Name, ast.Call, ast.Attribute)) for n in ast.walk(node)):
            return None
        return bool(eval(compile(ast.Expression(node), "<literal>", "eval"), {"__builtins__": {}}))
    except Exception:
        return None


class LocalFactor(ast.NodeTransformer):
    def visit_Name(self, node):
        if node.id == "strategy_type" and isinstance(node.ctx, ast.Load):
            return ast.copy_location(ast.Constant("factor"), node)
        return node

    def visit_If(self, node):
        if any(isinstance(n, ast.Call) and ast.unparse(n.func) == "asyncio.sleep" for n in ast.walk(node)) and isinstance(node.test, ast.BoolOp):
            return ast.parse('''
if progress and i % 32 == 0:
    progress(f"本机因子回测：{i + 1}/{len(bars)} 根…")
''').body[0]
        node.test = self.visit(node.test)
        value = static(node.test)
        if value is not None:
            branch = node.body if value else node.orelse
            return [new for statement in branch for new in self._statements(statement)]
        return self.generic_visit(node)

    def _statements(self, node):
        result = self.visit(node)
        return result if isinstance(result, list) else ([] if result is None else [result])

    def visit_IfExp(self, node):
        node.test = self.visit(node.test)
        value = static(node.test)
        return self.visit(node.body if value else node.orelse) if value is not None else self.generic_visit(node)

    def visit_Expr(self, node):
        if isinstance(node.value, ast.Await) and ast.unparse(node.value.value).startswith("asyncio.sleep("):
            return ast.copy_location(ast.Pass(), node)
        return self.generic_visit(node)

    def visit_Await(self, node):
        if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == "load_backtest_bars":
            raise RuntimeError("Remote history branch must be removed before export")
        return self.visit(node.value)

    def visit_AsyncFunctionDef(self, node):
        node = self.generic_visit(node)
        return ast.copy_location(ast.FunctionDef(name=node.name, args=node.args, body=node.body, decorator_list=node.decorator_list, returns=node.returns, type_comment=node.type_comment), node)

    def visit_ImportFrom(self, node):
        mapping = {
            "app.services.ai_trading.core.capital": "capital",
            "app.services.ai_trading.strategies.data_contract": "crypto_factor_kernel.data_contract",
        }
        if node.module in mapping:
            node.module = mapping[node.module]
        return node


tree = ast.parse(source)
function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "run_backtest")
# The provided history is the only data source, including each segment's warmup.
range_function = next(n for n in function.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_run_range")
history_branch = next(n for n in range_function.body if isinstance(n, ast.If) and ast.unparse(n.test) == "desktop_bars is not None")
history_branch.orelse = ast.parse('raise ValueError("本机回测缺少已验证的历史数据")').body
function.name = "run_factor_backtest"
function.args = ast.parse("def f(payload, bars, progress=None): pass").body[0].args
function = LocalFactor().visit(function)
function.body[0:0] = ast.parse('''
if str(payload.get("strategy_type") or "").lower() != "factor":
    raise ValueError("此本机回测入口仅支持因子公式")
payload = {**payload, "history_bars": bars}
''').body
hold = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_hold_days")
module = ast.Module(body=[function, hold], type_ignores=[])
ast.fix_missing_locations(module)
header = '''"""Server factor replay exported by scripts/export-factor-backtest.py.
Trading rules are shared with the server; all history and calculation are local.
"""
from __future__ import annotations
import logging
from datetime import date
from time import monotonic
from typing import Any
from crypto_account import VirtualAccount
from desktop_history import validate_desktop_history, slice_desktop_history
from crypto_bt_data import export_chart_bars, is_in_trade_range, max_days_for, parse_date, pick_random_segments, slice_signal_window, validate_range
from crypto_metrics import compute_metrics, downsample_equity, multi_segment_message, multi_segment_summary, summary_message
from crypto_signals import apply_hard_rules, normalize_action, quant_signal
from paper_specs import resolve_trade_params
logger = logging.getLogger("desktop.factor-backtest")
AI_MAX_CALLS = 24
DEFAULT_CASH = 1_000_000.0
'''
header += "# Source SHA256: " + hashlib.sha256(source.encode()).hexdigest() + "\n"
(root / "factor_backtest.py").write_text(header + "\n" + ast.unparse(module) + "\n", encoding="utf8")
for name, filename in [("account", "crypto_account"), ("desktop_history", "desktop_history"), ("signals", "crypto_signals")]:
    text = (app / f"services/backtest/{name}.py").read_text(encoding="utf8")
    text = text.replace("from app.services.backtest.data import WARMUP_BARS", "from crypto_bt_data import WARMUP_BARS")
    text = text.replace("from app.services.ai_trading.strategies import compute_quant_signal", '''def compute_quant_signal(strategy_type, bars, params, side_mode, position):
    if strategy_type != "factor":
        raise ValueError("此本机回测入口仅支持因子公式")
    from crypto_factor import compute_factor_signal
    return compute_factor_signal(bars, params, side_mode, position)''')
    (root / f"{filename}.py").write_text(text, encoding="utf8")

# Keep replay features/VM in a separate namespace. Research profiles and live
# Workers retain their original implementation and normalization contracts.
kernel = app / "services/factor_lab"
paths = ["__init__.py", "ops.py", "express.py", "vm.py", "token_encoding.py", "scoring/periods.py"]
paths += [str(path.relative_to(kernel)).replace("\\", "/") for path in (kernel / "features").glob("*.py")]
for name in paths:
    target = root / "crypto_factor_kernel" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    text = (kernel / name).read_text(encoding="utf8")
    text = text.replace("from app.services.trading_hours import trading_day_of_bar_time", "from ..calendar_day import trading_day_of_bar_time")
    text = text.replace("from app.services.signal_strength import", "from ..signal_strength import")
    target.write_text(text, encoding="utf8")
(root / "crypto_factor_kernel/scoring/__init__.py").write_text("", encoding="utf8")
(root / "crypto_factor_kernel/signal_strength.py").write_text((app / "services/signal_strength.py").read_text(encoding="utf8"), encoding="utf8")
hours = ast.parse((app / "services/trading_hours.py").read_text(encoding="utf8"))
day = next(n for n in hours.body if isinstance(n, ast.FunctionDef) and n.name == "trading_day_of_bar_time")
(root / "crypto_factor_kernel/calendar_day.py").write_text(ast.unparse(day) + "\n", encoding="utf8")
factor = (app / "services/ai_trading/strategies/factor.py").read_text(encoding="utf8")
factor = factor.replace("app.services.factor_lab", "crypto_factor_kernel")
factor = factor.replace("app.services.ai_trading.strategies.position_handlers", "strategies.position_handlers")
factor = factor.replace("from crypto_factor_kernel.features import feature_matrix", "from crypto_factor_kernel.selected_features import feature_matrix")
factor = factor.replace("feature_matrix(bars, normalization_window=norm if v3 else None)", "feature_matrix(bars, g, normalization_window=norm if v3 else None)")
(root / "crypto_factor.py").write_text(factor, encoding="utf8")
contract = (app / "services/ai_trading/strategies/data_contract.py").read_text(encoding="utf8")
contract = contract.replace("from app.services.ai_trading.strategies import normalize_strategy_params", "from crypto_factor import normalize_factor_params\n    normalize_strategy_params = lambda strategy, params: normalize_factor_params(params)")
contract = contract.replace("app.services.factor_lab", "crypto_factor_kernel")
(root / "crypto_factor_kernel/data_contract.py").write_text(contract, encoding="utf8")
data = ast.parse((app / "services/backtest/data.py").read_text(encoding="utf8"))
pure = [n for n in data.body if isinstance(n, (ast.FunctionDef, ast.Assign, ast.AnnAssign))]
pure_module = ast.Module(body=pure, type_ignores=[])
(root / "crypto_bt_data.py").write_text("from __future__ import annotations\nimport random\nfrom datetime import date, datetime, timedelta\nfrom typing import Any\n\n" + ast.unparse(pure_module) + "\n", encoding="utf8")
(root / "crypto_metrics.py").write_text((app / "services/backtest/metrics.py").read_text(encoding="utf8"), encoding="utf8")

# Evaluate only features referenced by the formula. Each retained expression and
# normalization is unchanged; expensive unused TA / desktop features are skipped.
compute_path = root / "crypto_factor_kernel/features/compute.py"
compute_source = compute_path.read_text(encoding="utf8")
compute_tree = ast.parse(compute_source)
selected = next(n for n in compute_tree.body if isinstance(n, ast.FunctionDef) and n.name == "compute_features")
selected.name = "compute_selected_features"
selected.args.kwonlyargs.append(ast.arg(arg="needed_names"))
selected.args.kw_defaults.append(ast.Constant(None))
raw = next(n for n in selected.body if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name) and n.target.id == "raw")
raw.value.values = [ast.Lambda(args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]), body=value) for value in raw.value.values]
out = next(n for n in selected.body if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name) and n.targets[0].id == "out")
out.value.value.args[0] = ast.Call(func=ast.Name(id="arr", ctx=ast.Load()), args=[], keywords=[])
out.value.generators[0].ifs.append(ast.parse("needed_names is None or name in needed_names", mode="eval").body)
for index, node in enumerate(selected.body):
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and ast.unparse(node.value.func) == "out.update":
        selected.body[index] = ast.If(test=ast.parse("needed_names is None or any(name in needed_names for name in FEATURE_NAMES[57:])", mode="eval").body, body=[node], orelse=[])
ast.fix_missing_locations(selected)
compute_path.write_text(compute_source + "\n\n# Generated selective replay path; full feature calculation stays available.\n" + ast.unparse(selected) + "\n", encoding="utf8")
(root / "crypto_factor_kernel/selected_features.py").write_text('''"""Select formula features without changing any feature or VM arithmetic."""
import numpy as np
from .features.compute import FEATURE_NAMES, compute_selected_features
from .token_encoding import FEAT_OFFSET, V3_FEAT_OFFSET, is_v3_tokens

def feature_matrix(bars, tokens, *, normalization_window=None):
    offset = V3_FEAT_OFFSET if is_v3_tokens(tokens) else FEAT_OFFSET
    names = {FEATURE_NAMES[int(t)] for t in tokens if 0 <= int(t) < min(offset, len(FEATURE_NAMES))}
    features = compute_selected_features(bars, needed_names=names, normalization_window=normalization_window)
    matrix = np.zeros((len(FEATURE_NAMES), len(bars)))
    for name in names:
        matrix[FEATURE_NAMES.index(name)] = features[name]
    return matrix
''', encoding="utf8")
print("Exported factor replay, decimal/leverage accounting, history validation and trade rules")
