"""Server factor replay exported by scripts/export-factor-backtest.py.
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
# Source SHA256: f8704b37b67d063d19a668e1f62bc06e5bbcaa675e6d93af6d71f07f805c4321

def run_factor_backtest(payload, bars, progress=None) -> dict[str, Any]:
    if str(payload.get('strategy_type') or '').lower() != 'factor':
        raise ValueError('此本机回测入口仅支持因子公式')
    payload = {**payload, 'history_bars': bars}
    '执行一次回测并返回报告。\n\n    multi_segment=True 时：在 [start_date, end_date] 内随机抽取 segment_count\n    个互不重叠的标准段（每段 = 周期上限天数），逐段独立回测（独立资金、\n    独立开平仓、每段结束强制平仓）后聚合成汇总报告。\n    '
    symbol = str(payload.get('symbol') or '').strip().lower()
    if not symbol:
        raise ValueError('请选择品种')
    timeframe = str(payload.get('timeframe') or '1d').strip()
    if timeframe not in ('1m', '5m', '15m', '30m', '60m', '240m', '1d'):
        raise ValueError('不支持的 K 线周期')
    start = parse_date(str(payload.get('start_date') or ''))
    end = parse_date(str(payload.get('end_date') or ''))
    multi_segment = bool(payload.get('multi_segment')) and timeframe != '1d'
    segment_count = int(payload.get('segment_count') or 2)
    validate_range(start, end, timeframe, segment_count=segment_count if multi_segment else None)
    strategy_type = str(payload.get('strategy_type') or 'n_breakout').strip().lower()
    strategy_params = dict(payload.get('strategy_params') or {})
    ref_strategies = payload.get('ref_strategies') or []
    side_mode = str(payload.get('side_mode') or 'both')
    _fq_raw = payload.get('fixed_qty')
    fixed_qty = float(_fq_raw) if _fq_raw is not None and float(_fq_raw) > 0 else None
    first_close = 1.0
    leverage = max(1.0, min(125.0, float(payload.get('leverage') or 1)))
    margin_per_trade = float(payload.get('margin_per_trade') or 0)
    margin_mode = 'isolated' if str(payload.get('margin_mode') or 'cross').lower() == 'isolated' else 'cross'
    initial_cash = float(payload.get('initial_cash') or DEFAULT_CASH)
    if initial_cash < 10000:
        initial_cash = 10000.0
    close_rules = dict(payload.get('close_rules') or {})
    stop_rules = dict(payload.get('stop_rules') or {})
    model_row_id = payload.get('model_row_id')
    symbol_name = str(payload.get('symbol_name') or symbol)
    from capital import TIMEFRAME_MAX_HOLD_DAYS, apply_style_to_trade_rules, normalize_risk_style
    try:
        risk_style = normalize_risk_style(str(payload.get('risk_style') or 'balanced'))
    except Exception:
        risk_style = 'balanced'
    base_max_hold_days = int(TIMEFRAME_MAX_HOLD_DAYS.get(timeframe, 10))
    custom_prompt_enabled = bool(payload.get('custom_prompt_enabled') or False)
    custom_prompt = payload.get('custom_prompt')
    if custom_prompt is not None:
        custom_prompt = str(custom_prompt).strip()[:2000] or None
    custom_prompt_enabled = False
    custom_prompt = None
    styled_rules = {'close_rules': dict(close_rules), 'stop_rules': dict(stop_rules), 'max_hold_days': base_max_hold_days, 'user_max_hold_days': base_max_hold_days, 'profile': {}, 'style_active': False}
    risk_style = 'balanced'
    user_close_baseline = dict(payload.get('close_rules') or {})
    user_stop_baseline = dict(payload.get('stop_rules') or {})
    close_rules = dict(styled_rules['close_rules'])
    stop_rules = dict(styled_rules['stop_rules'])
    max_hold_days = int(styled_rules['max_hold_days'])
    user_max_hold_days = int(styled_rules.get('user_max_hold_days') or base_max_hold_days)
    style_active = bool(styled_rules.get('style_active', not custom_prompt_enabled))
    params = resolve_trade_params(symbol, None)
    expected_data_tf = timeframe
    desktop_bars = validate_desktop_history(payload, expected_data_tf)
    if desktop_bars is not None:
        slice_desktop_history(desktop_bars, expected_data_tf, start, end)

    def _run_range(seg_start: date, seg_end: date, ai_call_budget: int) -> dict[str, Any]:
        """在 [seg_start, seg_end] 上独立执行一段回测（含结束平仓与指标）"""
        from crypto_factor_kernel.data_contract import required_signal_bars
        load_tf = timeframe
        sig_window = required_signal_bars('factor', timeframe, strategy_params)
        segment_params = {k: v for (k, v) in strategy_params.items() if not k.startswith('_strength_')}
        if desktop_bars is not None:
            bars = slice_desktop_history(desktop_bars, load_tf, seg_start, seg_end, sig_window)
        else:
            raise ValueError('本机回测缺少已验证的历史数据')
        account = VirtualAccount(cash=initial_cash, multiplier=float(params['multiplier']), leverage=leverage, margin_rate=float(params['margin_rate']), fee_mode=str(params['fee_mode']), open_fee=float(params['open_fee']), close_fee=float(params['close_fee']))
        equity_curve: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []
        ai_calls = 0
        ai_iface_fails = 0
        position_open_time: str | None = None
        position_sl: float | None = None
        was_reverse = False
        trade_bar_indices = [i for (i, b) in enumerate(bars) if is_in_trade_range(b, seg_start, seg_end)]
        ai_sample: set[int] = set()
        last_yield = monotonic()
        for (i, bar) in enumerate(bars):
            if progress and i % 32 == 0:
                progress(f'本机因子回测：{i + 1}/{len(bars)} 根…')
            if i == 0:
                try:
                    first_close = float(bar.get('close') or 0) or first_close
                except Exception:
                    pass
            price = float(bar.get('close') or 0)
            bar_time = str(bar.get('time') or '')
            if price <= 0:
                continue
            in_range = is_in_trade_range(bar, seg_start, seg_end)
            if not in_range:
                continue
            pos = account.position_dict()
            if position_open_time and pos:
                pos = {**pos, 'opened_at': position_open_time}
            hold_days = _hold_days(position_open_time, bar_time) if pos else None
            if pos and margin_mode == 'isolated' and (account.qty > 0) and (account.avg_price > 0) and (account.leverage > 1):
                _liq_px = account.avg_price * (1 - 1.0 / account.leverage) if account.side == 'long' else account.avg_price * (1 + 1.0 / account.leverage)
                _liq_hit = float(bar.get('low') or 0) <= _liq_px if account.side == 'long' else float(bar.get('high') or 0) >= _liq_px
                if _liq_hit:
                    _lq_qty = float(pos.get('quantity') or 0)
                    _lq_reason = f'逐仓强平（保证金击穿，强平价 {_liq_px:.8g}）'
                    account.apply('close', _lq_qty, _liq_px, bar_time, _lq_reason)
                    position_open_time = None
                    position_sl = None
                    decisions.append({'time': bar_time, 'action': 'close', 'quantity': _lq_qty, 'price': _liq_px, 'reason': _lq_reason, 'source': 'rule'})
                    pos = account.position_dict()
                    hold_days = None
            if pos and position_sl and (position_sl > 0):
                _sl_dir = str(pos.get('direction') or '')
                _touched = float(bar.get('low') or 0) <= position_sl if _sl_dir == 'long' else float(bar.get('high') or 0) >= position_sl
                if _touched:
                    _sl_qty = float(pos.get('quantity') or 0)
                    _sl_px = float(position_sl)
                    _sl_reason = f'信号K线止损（锚 {_sl_px:.8g} 盘中触及）'
                    account.apply('close', _sl_qty, _sl_px, bar_time, _sl_reason)
                    position_open_time = None
                    position_sl = None
                    decisions.append({'time': bar_time, 'action': 'close', 'quantity': _sl_qty, 'price': _sl_px, 'reason': _sl_reason, 'source': 'rule'})
                    pos = account.position_dict()
                    hold_days = None
            hard = apply_hard_rules(pos, price, stop_rules, close_rules, fixed_qty, max_hold_days=max_hold_days, hold_days=hold_days, risk_style=None, bar_high=float(bar.get('high') or 0), bar_low=float(bar.get('low') or 0))
            if hard:
                (act, qty) = (hard['action'], float(hard['quantity'] or 0))
                reason = hard['reason']
                exec_price = float(hard.get('trigger_price') or price)
                if exec_price <= 0:
                    exec_price = price
                account.apply(act, qty, exec_price, bar_time, reason)
                if act == 'close':
                    position_open_time = None
                decisions.append({'time': bar_time, 'action': act, 'quantity': qty, 'price': exec_price, 'reason': reason, 'source': 'rule'})
            else:
                signal_bars = slice_signal_window(bars, i, sig_window)
                _bt_params = segment_params
                if pos and position_open_time:
                    pos = {**pos, 'opened_at': position_open_time}
                sig = quant_signal('factor', signal_bars, _bt_params, side_mode, pos)
                source = 'factor'
                sig_qty = float(sig.get('quantity') or 0)
                if fixed_qty is None and sig_qty > 0:
                    sig_qty = sig_qty
                if fixed_qty is None:
                    ref_px = price if price and price > 0 else first_close
                    fixed_qty_eff = margin_per_trade * leverage / ref_px if margin_per_trade > 0 and ref_px > 0 else 1.0
                else:
                    fixed_qty_eff = float(fixed_qty)
                (act, qty) = normalize_action(str(sig.get('action') or 'hold'), 0, fixed_qty_eff, side_mode, account.position_dict())
                if act in ('open_long', 'open_short') and margin_per_trade > 0 and (price > 0):
                    qty = round(margin_per_trade * leverage / price, 8)
                reason = str(sig.get('reason') or '')
                if act != 'hold':
                    trade = account.apply(act, qty, price, bar_time, reason)
                    if trade:
                        if act in ('open_long', 'open_short') and position_open_time is None:
                            position_open_time = bar_time
                            was_reverse = False
                            _sig_sl = float(sig.get('sl_price') or 0)
                            if _sig_sl > 0:
                                position_sl = _sig_sl
                        if act == 'close':
                            position_open_time = None
                            position_sl = None
                        decisions.append({'time': bar_time, 'action': act, 'quantity': qty, 'price': price, 'reason': reason[:200], 'source': source})
            eq = account.equity(price)
            equity_curve.append({'time': bar_time, 'equity': round(eq, 2), 'cash': round(account.cash, 2), 'unrealized': round(account.unrealized(price), 2)})
        if bars:
            last = bars[-1]
            lp = float(last.get('close') or 0)
            lt = str(last.get('time') or '')
            if account.qty > 0 and lp > 0:
                account.apply('close', account.qty, lp, lt, '回测结束平仓')
                position_sl = None
                equity_curve.append({'time': lt, 'equity': round(account.equity(lp), 2), 'cash': round(account.cash, 2), 'unrealized': 0.0})
        final_price = float(bars[-1].get('close') or 0) if bars else 0
        final_eq = account.equity(final_price)
        metrics = compute_metrics(equity_curve, account.trades, initial_cash, final_eq, account.realized_pnl, account.fees_paid)
        chart_bars = export_chart_bars(bars, seg_start, seg_end, 1500)
        return {'metrics': metrics, 'equity_curve': equity_curve, 'bars': chart_bars, 'trades': account.trades, 'decisions': decisions, 'ai_calls': ai_calls, 'bar_count': len(bars), 'trade_bars': len(trade_bar_indices)}

    def _base_config() -> dict[str, Any]:
        return {'symbol': symbol, 'symbol_name': symbol_name, 'timeframe': timeframe, 'start_date': start.isoformat(), 'end_date': end.isoformat(), 'strategy_type': 'factor', 'strategy_params': strategy_params, 'side_mode': side_mode, 'fixed_qty': fixed_qty, 'initial_cash': initial_cash, 'risk_style': risk_style, 'style_active': style_active, 'max_hold_days': max_hold_days, 'user_max_hold_days': user_max_hold_days, 'custom_prompt_enabled': custom_prompt_enabled, 'model_row_id': str(model_row_id) if model_row_id else None, 'multi_segment': multi_segment, 'data_channel': str(payload.get('data_channel') or 'okx'), **({'history_source': payload['history_source'], 'history_timeframe': expected_data_tf, 'history_bar_count': len(desktop_bars)} if desktop_bars is not None else {})}
    if not multi_segment:
        r = _run_range(start, end, AI_MAX_CALLS)
        return {'status': 'completed', 'config': {**_base_config(), 'ai_calls': r['ai_calls'], 'bar_count': r['bar_count'], 'trade_bars': r['trade_bars']}, 'metrics': r['metrics'], 'equity_curve': downsample_equity(r['equity_curve'], 400), 'bars': r['bars'], 'trades': r['trades'][-200:], 'decisions': r['decisions'][-200:], 'message': summary_message(r['metrics'], 'factor', r['ai_calls'])}
    seg_days = max_days_for(timeframe)
    segments = pick_random_segments(start, end, segment_count, seg_days)
    per_seg_ai_budget = AI_MAX_CALLS
    segment_reports: list[dict[str, Any]] = []
    all_trades: list[dict[str, Any]] = []
    all_decisions: list[dict[str, Any]] = []
    stitched_curve: list[dict[str, Any]] = []
    total_ai_calls = 0
    total_bar_count = 0
    total_trade_bars = 0
    total_realized = 0.0
    total_fees = 0.0
    compound_factor = 1.0
    for (idx, (seg_start, seg_end)) in enumerate(segments):
        r = _run_range(seg_start, seg_end, per_seg_ai_budget)
        seg_metrics = r['metrics']
        for t in r['trades']:
            t['segment'] = idx
        for d in r['decisions']:
            d['segment'] = idx
        all_trades.extend(r['trades'])
        all_decisions.extend(r['decisions'])
        for pt in r['equity_curve']:
            stitched_curve.append({'time': pt.get('time'), 'equity': round(float(pt.get('equity') or 0) * compound_factor, 2), 'cash': round(float(pt.get('cash') or 0) * compound_factor, 2), 'unrealized': round(float(pt.get('unrealized') or 0) * compound_factor, 2)})
        if initial_cash > 0:
            compound_factor *= float(seg_metrics.get('final_equity') or 0) / initial_cash
        total_ai_calls += int(r['ai_calls'])
        total_bar_count += int(r['bar_count'])
        total_trade_bars += int(r['trade_bars'])
        total_realized += float(seg_metrics.get('realized_pnl') or 0)
        total_fees += float(seg_metrics.get('fees_paid') or 0)
        segment_reports.append({'index': idx, 'start_date': seg_start.isoformat(), 'end_date': seg_end.isoformat(), 'metrics': seg_metrics, 'equity_curve': downsample_equity(r['equity_curve'], 400), 'bars': r['bars'], 'trades': r['trades'][-200:], 'decisions': r['decisions'][-200:], 'ai_calls': int(r['ai_calls']), 'bar_count': int(r['bar_count']), 'trade_bars': int(r['trade_bars']), 'message': summary_message(seg_metrics, 'factor', int(r['ai_calls']))})
    final_stitched = float(stitched_curve[-1].get('equity') or 0) if stitched_curve else initial_cash
    agg_metrics = compute_metrics(stitched_curve, all_trades, initial_cash, final_stitched, total_realized, total_fees)
    summary = multi_segment_summary([sr['metrics'] for sr in segment_reports])
    return {'status': 'completed', 'config': {**_base_config(), 'segment_count': segment_count, 'segment_ranges': [[s.isoformat(), e.isoformat()] for (s, e) in segments], 'ai_calls': total_ai_calls, 'bar_count': total_bar_count, 'trade_bars': total_trade_bars}, 'metrics': {**agg_metrics, **summary}, 'segments': segment_reports, 'equity_curve': downsample_equity(stitched_curve, 400), 'bars': [], 'trades': all_trades[-200:], 'decisions': all_decisions[-200:], 'message': multi_segment_message(summary, 'factor', total_ai_calls)}

def _hold_days(open_time: str | None, bar_time: str) -> float | None:
    """粗略计算持仓天数（按 bar 时间字符串解析）"""
    if not open_time or not bar_time:
        return None
    from datetime import datetime

    def _parse(s: str) -> datetime | None:
        text = s.strip().replace('Z', '+00:00')
        for fmt in ('%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
            try:
                return datetime.strptime(text[:len(fmt) + 8], fmt)
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None
    a = _parse(open_time)
    b = _parse(bar_time)
    if a is None or b is None:
        return None
    return max(0.0, (b - a).total_seconds() / 86400.0)
