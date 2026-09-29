# Native portfolio evaluation boundaries

## Concrete existing implementation

`public/pykernel/factor_lab/scoring/portfolio.py::evaluate_portfolio`
estimates IC weights with `f[:eval_from]` and `ret[:eval_from]`.
`factor_local.py::run_mine_portfolio` sets eval_from to the sealed start
when selection_v2 is active. This prefix therefore includes validation
observations; in crypto_local_v2 its independent legacy split can also
include part of the sealed range. Both desktop finalizers call this path.
The existing engines and files remain unchanged.

## Proposed native-only implementation requiring product confirmation

Add `native-engine/engine/portfolio_ti.py`:

```python
evaluate_portfolio(session, qualified_champions) -> dict | None
```

- Only the already qualified final champion list enters the portfolio.
- Use the task-frozen research split: IC weights estimate on `[0, train_end)`.
- Score on the full frozen sealed range where configured; otherwise the
  frozen test range. No additional search or weight fitting on scored data.
- Fixed GPU f64 kernels compute factors/positions, IC, normalized weights,
  portfolio PnL/correlation/metrics. No numerical series on CPU.
- Preserve the existing token/position/cost/metric equations and output schema.
- Return optional `portfolio` in final precise output; before final it is null.
- No feedback to evolution, admission, champion ordering, or backfill.

Validation: compare equations against a new read-only CPU oracle that uses
explicit frozen training and scoring boundaries, test sealed perturbations
cannot change weights, double-run byte determinism, include new kernels in
startup selfcheck/IR coverage, renew G1/G2/G3 after version/hash change.
The existing portfolio oracle with eval_from is also compared for cases where
training and scoring boundaries coincide. No CPU implementation is modified.

Status: product approved the strict native-only training and scoring
boundaries on 2026-09-29. Implementation and validation are in M3.
