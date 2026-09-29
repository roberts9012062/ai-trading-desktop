# Native GPU champion qualification — product review

## Confirmed amendments

2026-09-29: product permits generation duration <=5 seconds. G2 is a
statistical equivalence gate, not a duration gate; composite relative error
<1e-9 and strict agreement >=99.9% remain. GPU utilization >=60%, 100 complete
generations, all deterministic safeguards and G4-G7 remain required.

Product also requests qualified champions only, using existing strict gates
and task configuration; no new DSR/PBO/turnover thresholds are introduced.

## Observed conflict requiring the design §4.2 decision

The frozen M2.25 complete G2 passes 56/56, with numerical source hashes
rechecked at completion. However, the unchanged CPU reference returns
exploratory fallback candidates when strict screening fails. Its legacy
selection path also keeps candidates with failed final sealed holdout metrics.
In the real ETHUSDT 70,174-bar / 3,000-population three-generation run,
6 of 10 final candidates have negative holdout Sortino. Their legacy WF
reports contain zero entirely out-of-training folds (`n_oos_folds=0`), so
`wf_stable=true` alone cannot certify out-of-sample walk-forward evidence.

Excluding such candidates from native champions can reduce raw champion
overlap with the unchanged CPU reference below the frozen 99% gate.

## Confirmed native-only delivery contract

- Keep the migrated research pipeline and every numerical value unchanged.
  Preserve raw candidates in `research_candidates` for audit and parity.
- Publish in `champions` only candidates passing existing strict gates,
  required task evidence and final sealed-holdout checks. Reject exploratory,
  rejected, missing/nonfinite required metrics, failed holdout, and missing
  genuine OOS WF evidence when WF is configured. Report explicit reasons.
- A nonfinal candidate is pending final holdout where configured. It is not
  labeled a final qualified champion. Incomplete evidence is not a pass.
- Use the existing positive-Sortino/cost-stress rules where applicable.
  No new DSR/PBO/turnover threshold. No edits to CPU/WebGPU/server logic.
- Reveal sealed holdout once at the final generation. Never use its values
  to evolve, backfill, rerank or retry the search. Failed qualification may
  legitimately yield zero champions.
- G2 continues raw composite, strict and research-candidate checks against
  the frozen CPU reference. Add a >=99% qualified-champion overlap check by
  applying exactly the same qualification rules to both engines' results.
  This changes the scope of the design's champion-set comparison and requires
  product confirmation before implementation.

## Files, interfaces and tests

- New `native-engine/engine/qualification.py`:
  `qualify_candidates(candidates, task_requirements, *, final_generation)`
  -> `{champions, pending, rejected}` with per-candidate reasons.
- Native `precise` returns raw research candidates plus qualification
  outputs; `best_seen` remains a training-only archive.
- Add native-only IPC result types and parity checks for the two collections.
- Tests: strict failure, insufficient samples, WF with zero OOS folds,
  missing/NaN metrics, failed base/stressed holdout, pending final reveal,
  no sealed values fed into evolution or training archives, no backfill.
- Real-run report must list every champion's required gate evidence; a
  fast run with rejected/pending candidates cannot certify champion quality.

Status: product confirmed "允许两层对拍与合格冠军门（推荐）" on
2026-09-29. Implementation and both layers of acceptance are required.
