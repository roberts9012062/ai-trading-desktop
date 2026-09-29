# Native GPU M2 execution checklist

Design authority: `docs/native-gpu-engine-plan.md`, sections 4, 5, 7 and 8.
This checklist implements that design and the approved mixed-mode amendment;
it does not change the design. M1 exit is recorded in commit `2ae7e33`.

## Order and files

1. Extend `scripts/verify-native-gpu-parity.py` first. Full G2 must require all
   7 symbols x 4 timeframes, both precisions, identical frozen bars/config/tokens,
   composite relative error <1e-9, champion overlap >=99%, and strict verdict
   agreement >=99.9%. Missing or duplicate coverage fails. Retain the M1 eval
   mode as a diagnostic. CPU reference provenance must be explicit; CPython
   diagnostics do not replace the actual existing desktop Pyodide reference.
2. Add `tests/native_engine/test_features.py` before the feature implementation.
   Compare all 62 append-only rows, missing-data masks, prefix behavior, warmup,
   open-interest forward fill, clock rounding and strength-index rounding.
3. Add `engine/series_ti.py` for resident f64 array primitives used by features,
   reusing the VM rounding guards and fixed rolling order. Add
   `engine/features_ti.py::compute_features(bars)` returning a resident GPU
   matrix and metadata. Only transport/parsing/control and scalar cost/year
   calculations run on the host. Feature arrays are never computed with numpy.
4. Extend `engine/metrics_ti.py` to the full CPU scoring contract, including
   slice bounds, execution models, funding cashflow and session-aware metrics.
   Add operator/metric parity before each numerical extension.
5. Add `engine/wf_ti.py` with `evaluate_on_slice(context, tokens, lo, hi)` and
   `walk_forward_eval(context, tokens)`, matching frozen views, normalization,
   warmup and split plans. Cache resident feature prefixes and slice results.
6. Add `engine/strict_ti.py` with `strict_eval(context, candidates)` and
   `precise(context, payload)`. Match `_strict_gate`, `_dedup_top`, peers,
   best_seen, prefetched_strict, final-generation and sealed holdout semantics.
   Numerical correlation/dedup metrics stay on GPU; scalar sorting/threshold
   decisions remain host control.
7. Wire the new numerical modules into `NativeSession` and `EngineServer`
   (`mine_features`, `eval_shards`, `precise`, `strict_eval`). Preserve M1 IPC
   behavior, task-frozen snapshots, heartbeat and disposal. No backend/UI work
   until the M2 exit passes.

## Exit and remaining numerical regressions

Verified checkpoints (M2 remains in progress):

- Original M1 3,000-token desktop reference now passes every raw composite
  after GPU libm exp/log1p fixes. The two failures remain in the frozen tokens.
- 64 native module/protocol tests passed in 634.559s before the training-program
  reuse improvement. New reuse regression proves no extra compilation for a
  changed bar count, head trim, cost or annualization; numerical checks pass.
- All 26 required compiled kernels passed the M2.4 IR audit with no atomic
  instructions. Repeat the audit after the runtime-parameter changes.
- Actual BTCUSDT 60m desktop full-pipeline reference passed mixed/f64 composite,
  champion and strict gates. This two-record diagnostic does not certify G2.
- All 28 verified real-data inputs and actual eight-worker desktop CPU
  full-pipeline references are frozen (15m/30m/60m/1d, seven symbols).
  The M2.6 full G2 attempt failed and was stopped after recording BTC/ETH/SOL
  regressions. Keep these cases and the original thresholds. Diagnose against
  the bundled WASM feature and intermediate operator outputs, then repeat G2.
- M2.7 addresses two confirmed amplification points: CUDA tanh ULPs change
  exact rank ties, and central-moment powers change a later SIGN at zero.
  New expm1/tanh and third/fourth pow ports pass frozen actual WASM vectors
  bitwise; f64 VM tanh also passes. Input bit patterns are stored explicitly
  to preserve subnormal values across JSON conversion. Repeat real regressions
  and the whole G2 after these changes; targeted passes alone do not certify it.
- G2 precise now uses the CPU pool's fixed eight-way round-robin merge order.
  The previous test compared different orders for composite-zero ties. This
  permutation is based on original candidate indices, before admission, and
  never on scores or expected champions. It preserves every candidate. Its
  regression tests pass. Reports now also stamp native numerical source hashes.
- The five previously failing cases (BTC 15m, ETH 30m/60m/1d, SOL 15m) now
  pass both mixed/f64 modes: all ten training/champion/strict comparisons pass.
  The real moment-to-SIGN fixture and all fourteen IPC/launcher tests pass.
  These remain diagnostic results (`G2_complete=false`). The full M2.7 attempt
  was stopped after 24 records: 21 passed; XRP 15m/30m/60m training composite
  failed although all three champion and strict comparisons passed.
- M2.8 fixes the confirmed XRP training cause: one-ULP CUDA tanh differences
  make flat-price zero cashflows negative and change Sortino's downside count.
  Training and report positions now use the desktop-compatible GPU tanh port;
  training returns/cashflows preserve each CPU f64 operation's rounding.
  Four frozen real XRP plateau fixtures fail before the fix and pass after it.
  Full XRP training positions, turnovers and cashflows now match WASM bitwise;
  the three composite relative differences are below 2e-15. Repeat full G2
  and G1/compiled-IR after this source change; no acceptance gate is waived.
- M2.8's seven metric tests (including both startup modes), three report tests
  and the real plateau fixture pass. The standalone training fixture exporter
  imports the unchanged desktop WASM scoring module and records its source hash.
- Real M2.8 profiling measured cold G1 at 132.859s, rank at 3.922s, strict at
  45.813s and precise at 19.219s. The report position kernel's outer runtime
  mode branch made its nested ranges serial: cashflow preparation accounted
  for 41.551s of strict and 11.703s of precise. M2.9 separates a parallel
  continuous-position range from the fixed-time discrete recurrence. All three
  reporting tests and the real plateau fixture pass; G1 now also double-runs
  discrete reports and the IR audit requires that kernel.
- M2.9 also reuses scalar reduction output buffers (six selection tests pass)
  and parallelizes coarse normalization across independent bars. A regression
  compares the retained M1 block path with the new dispatch bitwise over three
  lengths, both normalization profiles, small/large windows, crypto token
  detection and near-constant factors; it passes. Window summation and the
  raw standard-deviation tree remain unchanged. The IR audit now requires
  31 kernels. Repeat actual G3; no performance acceptance is claimed yet.
- Complete M2.9 G2 passes all 56 records (seven symbols, four frames, mixed
  and f64). Every champion overlap and strict agreement is 100%; every training
  and champion composite satisfies the frozen relative-error gate. Input,
  desktop reference and native source hashes are retained in
  `.local-data/native-gpu-reports/g2-full-m2.9-r1.json`. This result certifies
  that source snapshot; subsequent optimization requires another full run.
- The user authorized the four stale IndexedDB test lines (v4 to v5). Those
  exact changes are applied; both existing IDB cases pass. Production IndexedDB
  behavior is unchanged. Repeat the full G7 suite before claiming that gate.
- Real IPC M2.9 three-generation diagnostic still fails G3: 10.206s, 6.147s,
  7.997s; rank 3.693s/2.513s/2.341s; precise 6.492s/3.613s/5.637s.
  Time-weighted GPU utilization is 53.926%, sampling coverage 100%, VRAM peak
  3,504/6,141 MiB (57.06%). Cold G1 passes in 145.921s. Results are retained
  in `g3-mixed-m2.9-r1.json`; a short failed diagnostic cannot certify G3.
- M2.10 freezes known prefix signatures in one metadata pass and computes
  frozen price regime masks on GPU at setup. Four signature tests, seven
  selection tests and four session tests pass, including a check that setup
  evaluates no candidates/training/holdout scores and writes no segment cache.
  Full Vitest passes 191 cases with one existing skip (27 files).
- M2.11 caches candidate-independent 0/1/5/20-horizon returns on GPU and omits
  report-only IC5/20 from the private coarse rank path. Public authority still
  computes every report. Two tests verify CPU return bytes (including signed
  zero/terminal alignment), every ranking-consumed metric byte, repeated ranks
  and authoritative output after ranking. The compiled IR audit now requires
  32 kernels. Repeat startup, metric, precise, G2 and G3 checks for this snapshot.
- M2.11's seven metrics tests pass, including both startup modes and the real
  XRP zero-cashflow fixtures. Old stepwise and strict-shard scripts pass again.
- M2.12 skips already cached batch reports without touching LRU order (the new
  alias test fails before the fix and passes after it). Batched reports reuse
  read-only GPU price/funding/calendar inputs; four reporting tests pass,
  including all five shared-input modes and independent output buffers.
  Coarse normalization's four-way loop unroll retains ascending addition order;
  its original-block bitwise regression passes. Measure real G3 again, then
  repeat the complete G2 and compiled IR checks for this source snapshot.
- Real M2.12 diagnostic improves to 6.929s/4.053s/5.009s, with rank
  3.224s/2.058s/1.889s and precise 3.684s/1.977s/3.106s. GPU utilization is
  64.848%, coverage 100%, VRAM peak 3,608/6,141 MiB (58.75%). G3 still fails
  individual generation times; three generations do not certify sustained G3.
- M2.13 applies the design's f32 two-sum option to private coarse normalization.
  Exact f64 squares are materialized once per bar as two f32 components;
  windows accumulate those components in fixed ascending order. Overflow falls
  back to the retained original f64 window path. Authority remains unchanged
  GPU f64. New tests cover compensation error, repeat bytes, frozen prefixes,
  unchanged raw VM factors and large-value fallback; they pass. The original
  normalization oracle remains selectable and is also double-run at startup.
  Scratch bytes are included in tile budgeting; 34 kernels now require IR audit.
- Real M2.13 diagnostic measures 6.138s/3.713s/4.411s; rank
  2.553s/1.650s/1.534s; precise 3.564s/2.042s/2.864s. GPU utilization is
  62.421%, coverage 100%, VRAM peak 3,700/6,141 MiB (60.25%). G1 passes in
  135.687s. Generation time still fails G3. A new benchmark build on port
  4204 records authority, strict and enrichment durations separately.
- M2.14 introduces shared read-only feature prefixes with explicit VM logical
  bar counts. Independent stack/report buffers retain original slice calendars.
  Shared matrices are counted once in the existing 256 MiB context budget;
  when at most eight known prefixes fit, data-only buffers are prepared once
  before mining. No candidates, segment scores or sealed contexts are evaluated
  at setup. All seven prefix isolation, setup, batch cache and full
  precise/holdout regression tests pass (173.890s). The separate benchmark
  timing fields pass TypeScript checks; performance gate tests still reject
  shortened or over-budget scenarios. Real M2.14 G3 on fresh port 4204 passes
  G1 but still fails timing: generations 2/3 are 4.198s/5.241s, comprising
  rank 1.631s/1.485s, authority 0.074s/0.063s, strict 0.838s/0.859s and
  enrichment 1.624s/2.812s. Sampled utilization is 61.320%, coverage 100%,
  VRAM peak 3,810/6,141 MiB (62.04%). This diagnostic is not G3 acceptance.
- M2.14 profiling measures rank 2.734s (VM 1.479s, normalization 0.391s,
  positions 0.356s), strict 1.031s, precise 2.375s. Precise includes 65
  scalar VM dispatches and 84 scalar report evaluations.
- M2.15 batches selected champions' frozen train/test/WF/quarter slices, then
  retains original enrichment calls and segment-cache access order. Prefetch
  still writes no global segment scores. Three cache/scratch cleanup tests
  pass; five complete precise/holdout/joint and batch regressions pass in
  207.617s. Scalar fallback and v2 custom fold contexts are retained.
- M2.16 removes unused square sums from private coarse mean-only windows,
  retaining fixed ascending f64 additions and the old nonfinite policy. Its
  new byte oracle passes before the optimization. Private coarse positions
  now use f32 tanh; statistics remain the existing compensated f64 reductions.
  The metrics API refuses coarse positions for authoritative evaluation.
  Startup double-runs the actual private path; 35 kernels require IR audit.
  New tests check private f32 accuracy/repeatability and unchanged authority
  after ranking; the first run fails for the absent API before implementation.
  All ten coarse/authority separation, fixed window, prefix, compensation and
  source determinism regressions pass (63.924s). Measure real G3 again.
  The M2.16 diagnostic times out during the 180s startup handshake; no generation
  timings were produced. The new mean-only predicate is now excluded from f64
  compilation. Measure actual startup stages before choosing a JIT grace period.
- M2.17 reuses identical f64 positions and IC within one close/open/session
  report call. Discrete/spot and later factor calls always rebuild their inputs.
  Five report tests and the batch cache test pass; an old WF assertion reads
  the physical shared matrix rather than its logical prefix and is corrected
  to check shared identity plus the cropped feature interface. The complete
  report/batch/WF run took 241.101s; rerun its corrected failing case.
  Session preparation now publishes state only after all metadata/buffers are
  ready. Injected late failure/retry and three batch cache cleanup tests pass.
  Real startup profiling passes G1 in 213.078s: first feature graph 120.891s,
  f64 VM 67.437s, training 3.610s, reports 3.907s/discrete 1.968s, private
  VM 5.109s. The native-only cold-JIT handshake and audit deadline is now 300s;
  generation budgets and mandatory startup checks are unchanged. Six host
  performance/failure/cache contracts pass. Remeasure G3 with the full startup.
  M2.17 G3 remains failed: 6.347s/4.286s/5.191s; rank
  2.647s/1.645s/1.466s; strict 1.400s/0.982s/0.952s; enrichment
  2.184s/1.550s/2.661s. Utilization is 56.686%, coverage 100%, VRAM peak
  3,360/6,141 MiB (54.71%). Startup passes in 161.531s in this run.
- M2.18 extends the design's compensation option to private f32 rolling
  expression moments/regression. Fixed ascending loops use two-sum and Dekker
  product expansions; final combination is f64. Extreme/subnormal/nonfinite
  operands use the retained original f64 intermediate path. The old coarse
  program remains selectable for numerical oracles and startup double runs.
  Authoritative f64 ignores this option. New private tests cover supported
  moments/regression, repeat bytes, prefix isolation, magnitude fallback and
  unchanged strict output. The pre-implementation run fails for the missing API.
  All seven rolling/normalization/original-byte/prefix/source-contract tests
  pass (76.854s). Run real G3 with the new private path before more changes.
  M2.18 G3 still fails: 6.119s/3.916s/4.812s; rank
  2.750s/1.693s/1.505s; strict 1.093s/0.720s/0.641s; enrichment
  2.173s/1.414s/2.586s. Utilization is 58.145%, coverage 100%, VRAM peak
  3,333/6,141 MiB (54.27%). G1 passes in 239.079s.
- M2.19 caches coarse VM input chunks plus a 120-bar halo in per-block shared
  memory. Every original arithmetic operation and window read order remains
  unchanged; all lanes execute both barriers, including partial tail blocks.
  The f64 program retains direct reads. New tests compare all rolling operators
  bitwise against uncached programs (both compensation settings), NaN/extreme
  inputs, halo boundaries, repeat runs and frozen prefixes; this test passes.
  Selection training factors are prefetched in batches into <=3M-element
  temporary snapshots; scalar accesses still own factor-cache insertion/LRU
  movement. Four metadata/cache/failure contracts pass. Full pipeline is running.
  All twelve cache-byte/compensation/prefix/precise/sealed/joint/determinism
  pipeline regressions pass (305.010s). M2.19 G3 still fails:
  6.272s/4.507s/5.497s; rank 3.163s/1.922s/1.739s; strict
  1.118s/0.819s/0.785s; enrichment 1.876s/1.647s/2.872s.
  Utilization is 60.878%, coverage 100%, VRAM peak 3,365/6,141 MiB
  (54.80%). Shared input caching is slower in this measured run.
- Product approved the instruction candidate/time-block layout exception to
  design §2.1 on 2026-09-29. See the separate reviewable layout proposal.
  Preserve operator arithmetic, stack indices, ordered f64 prefix scans,
  original normalization trees and all G2/G3 thresholds. New tests were
  written first; decoder tests fail because the phase module does not exist.
  Numerical source remains frozen while full M2.19 G2 runs. A draft is kept
  outside the engine source tree until that run completes.
  Full M2.19 G2 now passes all 56 records (7 x 4 x both precisions).
  Every record's source hash was checked against the unchanged engine files
  after the run completed. Native-only integration has been promoted for
  M2.20; the original layout remains the default pending direct byte tests.
  All six new decoder/operator/normalization/prefix/nonfinite/original-byte
  tests pass (139.448s). The instruction grid is now the internal default;
  G1 explicitly double-runs the original and new layout in both precisions.
  New metadata/statistic allocations are included in the tile budget.
  M2.20 real-sidecar G1 passes in 198.765s, but the first coarse generation
  crashes before valid G3 timings: CUDA_ERROR_INVALID_CONTEXT during ndarray
  finalization on the WS thread. A minimal worker-allocation/main-GC experiment
  reproduces the same fatal error. Binding the numerical CUDA context to the
  WS thread fixes collection; resetting the runtime on its owner fixes exit.
- M2.21 adds a CUDA context lease for WS-thread finalizers. Automatic GC is
  suspended only during startup/context transitions; normal GC resumes after
  binding. Cleanup collects on the numerical executor, pops the WS lease,
  then resets Taichi on the CUDA owner. This adds no numerical work on the
  WS thread. Real subprocess GC/cancel/reset and blocked-worker heartbeat
  regressions pass (4.809s). Rerun G3 before any further optimization.
  M2.21 completes all three real generations without the context crash, but
  G3 remains failed: 7.097s/5.739s/6.294s; rank 3.065s/1.947s/1.819s;
  strict 1.465s/1.469s/1.043s; enrichment 2.431s/2.190s/3.293s.
  Utilization is 48.689%, coverage 100%, VRAM peak 3,338/6,141 MiB
  (54.36%). Startup G1 passes in 247.141s. Profile the new layout's CPU
  dispatch/kernel costs before deciding on another optimization.
- M2.21 kernel profile: initial rank 3.531s, GPU work 2.747s, including
  1.871s instruction evaluation and 0.465s private normalization. Strict is
  1.500s; enrichment 2.172s, with 1,497 kernel calls and 300 ndarray builds.
  Windows traceback/source-stat work accounts for about 0.7s of enrichment.
- M2.22 submits the unchanged phase kernels through a native sequential graph.
  A pinned Taichi 1.7.4 adapter uses the already-compiled C++ class kernels;
  no SDK patch or new arithmetic. A minimal bound-kernel graph experiment
  passes, and full graph-vs-direct byte comparisons pass (30.158s): both
  precisions, all operators, both normalization profiles/compensation modes,
  smaller counts, repeated runs and frozen logical prefixes. Graph submission
  is now the internal default. Remeasure G3 before more GPU/allocator changes.
  M2.22 G3 still fails: 6.565s/4.898s/6.180s; rank
  2.962s/1.921s/1.708s; strict 1.387s/0.999s/1.078s;
  enrichment 2.077s/1.845s/3.257s. Utilization 52.409%, coverage 100%,
  VRAM peak 3,208/6,141 MiB (52.24%).
- M2.23 adds data-only batch VM/report scratch reuse. Keys retain exact frozen
  input objects and widths; no scores, verdicts, factor-cache entries or segment
  aliases are written. Context and scratch retention share the existing cache
  budget (256 MiB primary / 64 MiB peers), including owner-input retention.
  Budget shrink evicts LRU scratch, oversized buffers stay ephemeral, and failed
  allocation publishes no partial entry. Five budget/failure/cache tests pass;
  all eight batch/precise/sealed/joint/WF GPU regressions pass (247.330s).
- M2.24 packs original active candidate row ids per instruction. Each GPU
  instruction visits only rows still executing tokens, retaining each row's
  stack, arithmetic and final result order. Prefix scans, scratch copy and raw
  statistic trees retain their existing numerical paths. Index buffers are
  charged to memory budgets. Seven control/budget/determinism tests pass;
  old-layout factor-byte and graph/direct tests are running before real G3.
  All seven original-layout factor-byte and graph/direct tests pass (84.628s).
  Real ETHUSDT 70,174-bar / population 3,000 three-generation G3 diagnostic
  is running. Do not certify the required 100-generation gate from this run.
  M2.24 G3 remains failed, with improved diagnostic timings:
  4.902s/3.534s/4.064s; rank 2.561s/1.619s/1.462s;
  strict 0.866s/0.681s/0.654s; enrichment 1.357s/1.126s/1.821s.
  Utilization 59.799%, coverage 100%, VRAM peak 3,313/6,141 MiB (53.95%).
  Startup G1 passes in 159.938s. Measure runtime vs compile-time opcode
  selection with the unchanged arithmetic before implementing specialization.
- M2.25 measured private arithmetic and bounded reuse (verification pending):
  compile-time opcode specialization did not improve heavy correlation,
  regression and long-window operators; it is not integrated. The Kahan
  experiment also regressed those operators (roughly 2x for 29/35/49).
  Existing fixed ascending f64 intermediate windows are 10-30% faster than
  the private two-sum/Dekker profile, so they are selected for coarse rolling.
  Private coarse normalization still uses compensation; public authority is
  still f64 and all frozen public thresholds are unchanged.
  Training factor prefetch now acquires the same budgeted batch buffers as
  slice evaluation. Untrimmed DSR reports reuse their frozen train calendar.
  Final legacy holdout slices are batched only inside final enrichment, with
  original scalar cache admission order and both scratch maps restored on
  exceptions. Nine host cache/lifetime/seal tests pass; CUDA pipeline tests
  and a fresh real G3 diagnostic are required before any claim of improvement.
  All 16 CUDA layout/slice/precise/WF tests pass in 236.386s, including final
  holdout and joint-peer numerical comparisons. M2.25's real three-generation
  diagnostic remains failed: 4.738s/3.547s/3.906s, GPU utilization 55.704%,
  sampling coverage 100%, VRAM 3,415/6,141 MiB (55.61%). Rank:
  2.382s/1.498s/1.431s; strict: 0.866s/0.690s/0.673s; enrichment:
  1.372s/1.240s/1.687s. G1 startup passes in 159.437s.
  A corrected normalization probe measures compensation at 0.02915s versus
  fixed ascending f64 windows at 0.05873s (128 x 49,122, 250-bar windows), so
  coarse normalization retains compensation. The first probe accidentally
  took the legacy constant shortcut and is invalid; it informed no engine
  change. Complete M2.25 G2 is running with numerical sources frozen.
- G3 core harness records every generation and all mining wall time. Gate tests
  reject a slow individual generation, short run, low utilization or missing
  sampling coverage. Actual 100-generation acceptance remains outstanding.
- The first three-generation mixed diagnostic failed: 62.8s/34.3s/76.6s and
  33.9% GPU utilization. Profiling found repeated prefix feature preparation,
  scalar report launches, correlation reductions and ndarray construction.
  M2.6 shares crypto prefixes, batches slice reports without changing cache
  insertion order, and batches the original correlation trees. Regression
  checks pass, including all four precise/holdout/joint tests. Measure again
  after repairing the G2 failures; these optimizations do not certify G3.

- The original two real M1 3,000-token composite failures are fixed and remain
  in the frozen batch. Repair the newly exposed full-suite regressions without
  filtering candidates or weakening the approved 1e-9 gate.
- Run complete G2 against the unchanged desktop CPU engine. Export raw
  reference/results and input hashes. Include champions and strict verdicts;
  a VM-only or zero-composite smoke report is not full G2.
- Verify G3 core on ETHUSDT perpetual 15m, 70,174 bars, population 3000 x 100:
  <=5s/generation (product amendment 2026-09-29) and sampled GPU utilization
  >=60% during sustained mining.
  M1's five eval-only rounds do not certify this.
- Repeat both startup modes, fixed-window/prefix tests, compiled-IR atomic
  audit, and memory checks after the numerical changes. Retain 100k/200k/300k
  device guards and the <70% VRAM budget.
- M2 remains incomplete until these exits pass. M3 integration, M4 packaging,
  eight-hour soak and release remain later milestones.

## Confirmed product amendments and current verification

- Product permits <=5s per generation. G2 is numerical equivalence, so its
  composite/strict thresholds are unchanged. Performance tests reject 5,000.01ms.
- Product confirms existing strict/task gates, no new DSR/PBO/turnover cutoff,
  and the two-layer qualified-champion contract in the qualification proposal.
  M2.25 real diagnostics reveal zero entirely OOS WF folds for the legacy
  configuration and negative final holdout Sortino in six of ten candidates.
  The qualified delivery layer must reject incomplete/failed evidence.
- M2.25 full G2 passes 56/56; hashes were rechecked before the next snapshot.
- M2.26 unchanged-kernel report graph: six CUDA report comparisons pass in
  6.817s; continuous cashflow bytes match direct submission.
- M2.27 qualification/strict proof/graph pipeline: 13 CUDA tests pass in
  156.226s. Twelve qualification tests include rounded integral counters,
  strict forgery refusal, failed or missing OOS evidence, final holdout,
  no mutation/backfill and nonfinal sealed-data exclusion. Parity tests also
  reject missing research candidates or a forged public qualified set.
- M2.28 adds exact native-engine-version provenance to authoritative outputs;
  stale or non-f64 seed archives are rejected. Frozen CPU-reference audit
  finds seven genuinely qualified candidates across the 28 cases, so full G2
  cannot be certified merely from empty qualified sets. Compiled IR/G1,
  complete two-layer G2, 100-generation G3 and whole native suite remain pending.
- M2.28 host qualification/parity/performance/determinism tests pass (26 tests),
  plus current-version f64 admission regression. Full Vitest passes 192 tests
  with one existing skip; benchmark TypeScript check passes.
- First M2.28 IR run passes both 20-token startup checks and finds no atomic
  instructions, but reports 39/40 kernel names. A minimal CUDA reproduction
  confirms Taichi aliases identical feature/selection copy bodies in its
  in-memory compilation cache, emitting only the first body's IR name.
  The audit now compiles and byte-checks the selection copy in a separate
  process, then audits complete G1. It streams the large log without holding
  multiple full copies in memory. No numerical kernel or threshold changes.
  The corrected full audit passes 40/40 required kernels, with no atomic IR.
  Both startup modes pass; mixed takes 213.438s and f64 6.359s in the same
  process. Digests match the first run. Whole native suite is next.
- M2.28 whole native suite passes 130 tests in 662.241s, including real
  sidecar/authentication, failed-selfcheck startup refusal, responsive
  heartbeat under blocked numerical work, CUDA lifetime cleanup, all VM
  layouts, features, reports, WF, strict, precise and qualification. Complete
  two-layer G2 is running with all engine sources frozen.
- Complete M2.28 two-layer G2 passes 56/56. CPU and native each yield 14
  qualified champions; minimum raw-candidate overlap, qualified-champion
  overlap and strict agreement are all 100%. All evaluated/shared composite
  gates pass the unchanged true relative <1e-9 threshold. Every recorded
  native source hash is rechecked unchanged at completion.
  Report: `.local-data/native-gpu-reports/g2-full-m2.28-r1.json`.
  G3's real 100-generation mixed run starts next; M2 remains pending G3.
- M2.28 completes all 100 real G3 generations and passes every core gate.
  Maximum 4.5971s, median 1.54435s, mean 1.885782s; final generation 1.6464s.
  Sustained time-weighted GPU utilization 76.393984%, coverage 100%, 912
  samples at 200ms. Peak VRAM 2,539/6,141 MiB (41.345%). G1 cold startup
  149.453s is recorded separately. Final raw candidate is rejected for strict
  failure/research-only status, missing genuinely OOS WF evidence and failed
  sealed holdout; zero qualified champions are published. Workload is not
  shortened or replaced. Numerical source hashes still match full G2.
  Report: `.local-data/native-gpu-reports/g3-mixed-m2.28-100-r1.json`.
- M2 exit is achieved. Commit the verified snapshot, then begin M3. G4's
  large-range memory checks, G5/G6 integration/soak and M4 release remain open.
