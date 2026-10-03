# Multi-cycle hunter implementation plan

**Goal:** Add a desktop opportunity scanner and autonomous server-managed trades without changing existing strategies.

**Architecture:** New namespaced `/api/hunter` API, new controller/opportunity tables, immutable trade plans, and a dedicated server runner. Existing task creation, accounting and exchange execution are reused. Existing strategies never enter the hunter runner. Desktop scanning remains alive across page navigation and stops on logout. Closed trades cannot reopen.

**Tech stack:** React/Zustand/TypeScript, FastAPI/Pydantic/SQLAlchemy, existing exchange adapters and paper engine.

## Steps and verification
1. Record baseline checks; preserve unrelated changes. Add pure risk/signal tests before implementation.
2. Implement closed-bar trend/breakout/retest rules and risk sizing in isolated desktop/server modules. Test forming bars, expired signals, adverse prices, costs, stop tightening and partial exits.
3. Add controller/opportunity persistence, authenticated API, model review and mount idempotency. Lock account/controller during reservation. Revalidate from server-owned data; no client-authoritative risk decisions.
4. Add isolated runner using existing task/execution/accounting functions. Maintain protection while desktop is offline; partial fills and ambiguous outcomes remain reserved until reconciled. Add only registration/ownership hooks to existing files.
5. Add creation panel, independent scanner, group cards, pause-search and stop/close actions. Reuse existing model lists; no changes to existing selectors. Research mining stays in the existing CPU/GPU lab until a independently validated, mountable result is selected; no fabricated live qualification.
6. Run desktop typecheck/tests/build and backend hunter plus existing AI/shortline regression tests. Inspect diff and document operational limitations honestly; do not launch real trades.

## Baseline
- Desktop clean; server has unrelated untracked `errors.log` (preserved).
- Server full-suite collection fails before edits: `test_market_channel.py` imports removed `DEFAULT_OPENCTP_MD_FRONT_724`. Scope does not include fixing this existing issue.
- Real trading requires independent qualification and validated exchange execution capabilities. Default new hunter research is simulation, never a silent substitute for real trading.

## Delivered and verified
- Additive simulation controller, desktop discovery, authoritative mount, optional LLM/Jev veto, bounded entry, dedicated position manager and UI delivered.
- Desktop: typecheck/build passed; latest suite 555 tests passed, 1 existing skip.
- Backend: 67 hunter tests and 204 tests across the relevant regression suite passed. The four baseline mismatches have been audited and corrected in tests without changing the original trading rules. Relevant regressions now include those tests. Full collection still has two existing removed-import errors.
- Isolated browser fixture verified parameter submission, model filtering, group rendering and pause/resume state. No production task, real order, deployment or desktop installer was created.
- Live execution, independent historical profitability qualification and complete funding/model-cost settlement remain unimplemented; the UI/API reject live rather than imply qualification. Details are in ../multi-cycle-hunter.md.

## Leverage extension
- Add a hunter-only integer leverage setting, default 1, range 1–50, with desktop and server validation. Old configs/plans without leverage keep 1x.
- Keep account-loss sizing and the 20% single-coin notional ceiling. Calculate margin as notional/leverage and fees from full notional; include both in capital reservations.
- Reject a trade if stop distance plus estimated costs consumes at least 50% of initial margin, rechecking at the worst allowed limit price. Do not tighten a structural stop to force a trade. Freeze leverage with the opportunity.
- Verify 1x/5x/50x paper fills and capital release with the real ORM/ledger, cents rounding on small margin, invalid leverages, and an altered task that disagrees with the frozen plan. Use only the isolated browser fixture for UI submission.

## OKX and margin-mode extension
- Restrict new hunter creation, market routes, desktop scans and new mounts to OKX. Keep existing exchange adapters and existing-position protection unchanged.
- Add isolated/cross mode selection (default isolated), storing the choice in the group, immutable opportunity and child task. Reject a task/plan mismatch before opening.
- Verify both modes with 1x/5x/50x fills, stops and capital release; reject unknown modes and non-OKX configuration. Existing plans lacking a mode retain isolated semantics.
- Paper matching still uses the original shared ledger and per-trade reservation. Exchange-specific isolated loss isolation, cross collateral replenishment and liquidation simulation are not implemented by this parameter extension; document the limitation in UI and user docs.
