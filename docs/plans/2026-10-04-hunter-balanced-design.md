# Hunter balanced discovery

Approved scope: independent cycles, incremental data, a pending candidate watchlist,
30% relative rank, 1.3x short breakout volume and EMA20 trend pullback entry.

1. Keep hunter-v1 as the default for old API clients/configs; introduce hunter-v2
   as the new desktop creation default and an explicit upgrade control. Freeze the
   selected version and entry kind on each opportunity. Existing positions and all
   risk/exit limits remain unchanged.
2. Add bounded, authenticated read-only batch snapshots under /api/hunter. Ranking
   snapshots contain daily/hourly history; context snapshots load only selected
   candidates. Use cursors to send overlapping deltas or reset after history gaps.
   Server caches/singleflight remain shared, and mount independently revalidates.
3. Schedule short/medium/long independently and prioritize short jobs; refresh on
   each execution-candle close plus configured retry cadence. One mount queue per
   desktop owner refreshes reservations between requests. Abort on pause, stop,
   profile change, logout or mode switch. Never use direct desktop OKX connections.
4. Maintain a bounded, in-memory candidate watchlist per hunter/cycle/direction.
   Refresh data only for currently rank-qualified candidates, track breakout/retest
   and EMA pullback states. Drop invalid, unranked, expired or held symbols. Watchlist
   is explanatory/acceleration state, never authority to bypass current checks.
5. Implement matching deterministic TypeScript/Python v2 rules: rank 30%, short
   volume 1.3x, short TTL 180s, EMA20 pullback with trend, structural ATR stop,
   closed-bar reversal confirmation and existing target-space validation. Select
   newest valid entry deterministically, with entry-kind-specific server checks.
6. Verify golden long/short signals and v1 compatibility, delta/reset/gap handling,
   ranking completeness, stale signals, stop/session cancellation, independent
   schedules, serialized mounts and unchanged risk protection. Run desktop checks,
   relevant server regressions and isolated UI preview, never test real orders.
7. Publish desktop v0.2.84 through existing signed release workflow; upload server
   code and deploy backend container with backup and read-only health validation.

Profitability remains unverified. Validation of execution correctness is separate
from out-of-sample validation of returns and drawdown. No forced trades or relaxed
liquidity, cost, margin, position or drawdown guards.
