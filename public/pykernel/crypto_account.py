"""回测虚拟账户 —— 纯函数/状态类，不落库"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class VirtualAccount:
    """虚拟资金与单品种持仓（USDT 口径，数量=基础币，支持小数与杠杆）"""

    cash: float
    multiplier: float
    margin_rate: float
    fee_mode: str
    open_fee: float
    close_fee: float
    leverage: float = 1.0
    # long / short / flat
    side: str = "flat"
    qty: float = 0.0
    avg_price: float = 0.0
    realized_pnl: float = 0.0
    fees_paid: float = 0.0
    trades: list[dict[str, Any]] = field(default_factory=list)

    def equity(self, last_price: float) -> float:
        """权益 = 现金 + 浮动盈亏"""
        return self.cash + self.unrealized(last_price)

    def unrealized(self, last_price: float) -> float:
        if self.side == "flat" or self.qty <= 0:
            return 0.0
        m = self.multiplier
        if self.side == "long":
            return (last_price - self.avg_price) * self.qty * m
        return (self.avg_price - last_price) * self.qty * m

    def _fee(self, price: float, qty: float, is_open: bool) -> float:
        rate = self.open_fee if is_open else self.close_fee
        if self.fee_mode == "rate":
            return abs(price) * qty * self.multiplier * rate
        return abs(rate) * qty

    def _margin(self, price: float, qty: float) -> float:
        # 杠杆口径：保证金 = 名义价值 / 杠杆（r20 模型；leverage=1 即全款）
        return abs(price) * qty * self.multiplier / max(1.0, self.leverage)

    def position_dict(self) -> dict[str, Any] | None:
        if self.side == "flat" or self.qty <= 0:
            return None
        return {
            "direction": self.side,
            "quantity": self.qty,
            "available_quantity": self.qty,
            "avg_price": self.avg_price,
        }

    def apply(
        self,
        action: str,
        quantity: int,
        price: float,
        bar_time: str,
        reason: str,
    ) -> dict[str, Any] | None:
        """执行开平，返回成交记录或 None"""
        act = str(action or "hold").strip().lower()
        qty = max(0.0, float(quantity or 0))
        if act in ("hold", "") or qty <= 0 or price <= 0:
            return None

        # 统一：close 平当前仓
        if act == "close":
            return self._close(min(qty, self.qty), price, bar_time, reason)
        if act == "open_long":
            if self.side == "short":
                self._close(self.qty, price, bar_time, "反向先平空")
            return self._open("long", qty, price, bar_time, reason)
        if act == "open_short":
            if self.side == "long":
                self._close(self.qty, price, bar_time, "反向先平多")
            return self._open("short", qty, price, bar_time, reason)
        return None

    def _open(
        self,
        side: str,
        qty: float,
        price: float,
        bar_time: str,
        reason: str,
    ) -> dict[str, Any] | None:
        fee = self._fee(price, qty, True)
        margin = self._margin(price, qty)
        need = margin + fee
        if self.cash < need:
            # 降仓（按可承受名义反推数量，保留基础币小数）
            if margin <= 0:
                return None
            affordable_notional = max(0.0, (self.cash - fee) * self.leverage)
            max_qty = affordable_notional / (abs(price) * self.multiplier)
            qty = min(qty, round(max_qty, 8))
            if qty <= 0:
                return None
            fee = self._fee(price, qty, True)
            margin = self._margin(price, qty)
            need = margin + fee
            if self.cash < need:
                return None

        if self.side == side and self.qty > 0:
            # 同向加仓
            total = self.qty + qty
            self.avg_price = (self.avg_price * self.qty + price * qty) / total
            self.qty = total
        else:
            self.side = side
            self.qty = qty
            self.avg_price = price

        self.cash -= fee
        self.fees_paid += fee
        trade = {
            "time": bar_time,
            "side": "buy" if side == "long" else "sell",
            "action": f"open_{side}",
            "price": price,
            "quantity": qty,
            "fee": round(fee, 2),
            "margin": round(margin, 2),
            "leverage": self.leverage,
            "pnl": 0.0,
            "reason": reason[:200],
        }
        self.trades.append(trade)
        return trade

    def _close(
        self,
        qty: float,
        price: float,
        bar_time: str,
        reason: str,
    ) -> dict[str, Any] | None:
        if self.side == "flat" or self.qty <= 0 or qty <= 0:
            return None
        qty = min(qty, self.qty)
        m = self.multiplier
        if self.side == "long":
            pnl = (price - self.avg_price) * qty * m
            close_side = "sell"
        else:
            pnl = (self.avg_price - price) * qty * m
            close_side = "buy"
        fee = self._fee(price, qty, False)
        self.cash += pnl - fee
        self.realized_pnl += pnl
        self.fees_paid += fee
        self.qty = round(self.qty - qty, 8)
        if self.qty <= 0:
            self.side = "flat"
            self.qty = 0
            self.avg_price = 0.0
        # 单笔收益率双口径（r20 对照）：
        # 保证金口径 = pnl / 本笔保证金 —— 杠杆放大后的真实收益率（5倍杠杆±1%价格=±5%）
        # 名义口径   = pnl / 名义价值 —— r20 的 pnl_pct 口径（价格变动百分比）
        margin = abs(price) * qty * m / max(1.0, self.leverage)
        notional = abs(price) * qty * m
        trade = {
            "time": bar_time,
            "side": close_side,
            "action": "close",
            "price": price,
            "quantity": qty,
            "fee": round(fee, 2),
            "pnl": round(pnl, 2),
            "margin": round(margin, 2),
            "leverage": self.leverage,
            "pnl_pct_margin": round(pnl / margin * 100, 2) if margin > 0 else 0.0,
            "pnl_pct_notional": round(pnl / notional * 100, 2) if notional > 0 else 0.0,
            "reason": reason[:200],
        }
        self.trades.append(trade)
        return trade
