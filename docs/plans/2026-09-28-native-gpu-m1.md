# Native GPU M1 implementation

Goal: the approved M1 PoC from `docs/native-gpu-engine-plan.md`, with the product
approved mixed-precision amendment recorded below.

Architecture: CPython 3.11 + Taichi sidecar, authenticated loopback WebSocket,
task-frozen bars/features, dtype-parameterized WGSL stack VM and native training
evaluation. CPU feature preparation is explicitly PoC-only; M2 replaces it.

## Sequence / gates

1. Write parity, VM, protocol, determinism, lifecycle and memory tests first.
2. Pin Python dependencies; implement protocol and sidecar skeleton.
3. Implement Taichi VM, deterministic reductions and training metrics.
4. Implement sessions, mandatory startup G1 and Tauri/TS transport.
5. Benchmark the same frozen 70,174 ETHUSDT 15m bars / 3,000 tokens on native
   and the existing eight-worker Pyodide pool. Include IPC/readback/sync; exclude
   initialization on both sides. Report both precision modes separately.
6. M1 exits only with G1 passed and native evaluation >=8x actual CPU pool.
   Do not begin M2 before both gates pass. Do not substitute synthetic/repeated
   short history or CPython multiprocessing for the real acceptance baseline.

## Protected files / approved wiring

Existing cpu-backend, gpu-backend, shard-pool, Python kernel and verification
scripts remain unchanged. New files live under native-engine/engine,
src/lib/native-engine, tests/native_engine and scripts. Approved existing-file
changes are Cargo.toml/lib.rs for shell plugin and command registration and
package.json plus dependency lockfiles. Factory/UI/backend integration is M3.

## Precision and deterministic execution

Product approval (2026-09-28): "保留阈值，允许 GPU f64 权威重算".
Mixed: GPU f32 coarse ranking plus GPU f64 authoritative recomputation from the
original f64 features. Coarse output contains tokens/scores only; every public
metric comes from the authoritative path. Strict: f64 throughout.
Same-machine/card/version bitwise reproducibility; CPU statistical
equivalence remains composite relative error <1e-9, top-N overlap >=99%, strict
verdict agreement >=99.9%. Never weaken thresholds. Test each mode separately,
including both passes in mixed startup G1. CPU zero composite is checked separately.

The WGSL executable body already uses causal window-250 normalization; its
header's global-normalization comment is stale. Port executable semantics,
test CPU boundary behavior, never alter either existing engine.

Mandatory tests: fixed tree/block reductions without float atomic; fixed window
iteration; no ti.random; startup 20 fixed tokens evaluated twice with full byte
comparison. Failed G1 prevents ready/available state.

## Evidence

Store raw machine-readable reports under ignored .local-data/native-gpu-reports.
Missing coverage is failure/incomplete, not a passing skip. M1 parity checks VM
and training eval. M2 extends the same script to full G2 on 7 symbols x 4 frames,
features/WF/strict/precise. GPU memory remains below 70%; existing 100k/200k/300k
device-tier guards are passed through unchanged. Every web rebuild uses a new
test port (4193, 4194, ...).

## Progress

- Planning approved by user; implementation started.
- Managed checkout: `codex/native-gpu-engine`, based on main `6cd2643`.
- G1 passed in mixed and f64: 20 fixed tokens, factors and raw metrics repeat
  byte for byte. Injected startup failure exits without publishing ready.
- 19 native Python tests, 9 IPC/launcher tests and 3 Rust tests passed.
- Compiled Taichi IR audit passed for both VM precisions and all metric kernels;
  no atomic instructions. Fixed-window prefix tests passed in both precisions.
- Original stepwise and strict-shard verification scripts passed unchanged.
- Typecheck and dedicated production benchmark build passed.
- Baseline vitest already had two idb tests expecting version 4 instead of 5.
  A test run alongside CPU benchmarking also had a runner timeout; repeat idle
  before drawing regression conclusions. No existing test or engine was edited.
- Real fixture: ETHUSDT perpetual 15m, 70,174 bars, 2024-01-01 through
  2025-12-31 23:15 UTC, SHA256
  `c95d5a0cea7af5b98a387622a598a3938002244541f8ed488faa200c5483439c`.
- M1 performance **failed**: native mixed 4.060–4.240s; CPU 23.617–30.170s;
  speedup 5.770–7.292x across five rounds. First two CPU rounds overlap other
  verification and are diagnostic only; rounds 3–5 still fail the 8x gate.
  Valid candidate counts differ (CPU 2515 vs native 2526). Device-wide VRAM peak
  during this run: 1592/6141MB (25.9%); this is not a full G4 certification.
- The 70k evaluation probe found mixed composite errors up to 7.09e-7 among
  nonzero examples, plus zero/nonzero mismatches. Strict f64 also has rolling
  cancellation/order boundary differences to resolve; no G2 claim is made.
- A controlled experiment using only unchanged CPU operators, per-node f32
  rounding, then unchanged CPU f64 normalization/scoring reproduces 7.04e-7
  composite error. This isolates loss of expression precision from GPU port bugs.
  `verify-native-gpu-precision-control.py` reproduces that diagnostic.
- Product approved f32 coarse ranking + f64 authoritative recomputation while
  retaining every precision threshold. After the rounding-boundary fix the
  original twelve-token 70k failure probe passes in mixed authority mode.
  Full-population parity and performance remain under verification.
- f64 rounding regression now covers CUDA reciprocal multiplication, variance
  contraction, CPU RESID cumsum means and nested long-prefix cancellation.
  Eight VM checks pass. Generic per-dtype programs keep T/config as runtime
  data so post-hello sessions reuse the startup compilation.
- The first authority benchmark attempt (port 4198) failed before timing:
  per-session LLVM compilation held the GIL and starved heartbeat. No timing
  numbers from that attempt are acceptance evidence. The generic program fix
  and real session liveness are being retested.
- Generic VM reuse passed the real 4199 benchmark heartbeat. 23 native tests,
  10 TS transport tests, Rust tests and typecheck passed at m1.2.
- m1.2 authority performance remains below the M1 exit: native 3.714–3.831s,
  CPU 23.678–26.562s, 6.181–7.153x. All 2,515 valid candidate identities match.
  Isolated profiling: VM 2.700s, metrics 1.049s (not certification timing).
- m1.3 caches position/PnL/turnover on GPU, avoids compensating exact integer
  counts, and retains f64 rounded normalization intermediates. Metrics/G1 checks
  pass; full regression and the real performance gate are pending.
- m1.4 removes dynamic local Vector(20) indexing and reuses shared prefix
  storage (18,432 -> 6,144 bytes per block). VM regression passes, but isolated
  timing shows no material speed gain from those changes alone.
- Scheduling diagnosis on the unchanged 3,000-candidate fixture: VM original
  order 2.797s, length order 2.484s, fixed work-weight order 2.303s. This is
  diagnostic evidence, not the M1 gate. Internal launch order now groups similar
  work; original result order, duplicates and candidate admission are retained.
- m1.5 preloads eight prefix inputs while adding them in the original ascending
  time order. 26 native tests pass (249.657s), including byte-exact CPU mean/std
  at chunk/tail boundaries, head-trim PnL reset, scheduling invariance, both G1
  modes and real sidecar protocol/liveness. The next benchmark uses port 4200.
- Acceptance now compares candidate multiplicity in every timed round, rather
  than token sets only in the final round. No existing engine was changed.
- The mixed m1.5 M1 gate passes five actual eight-worker rounds: CPU
  34.698–46.871s, native 2.873–3.208s, ratios 11.056–15.703x. All rounds have
  identical 2,515 valid candidates, including multiplicity. Fixture SHA is
  unchanged. Device-wide sampled VRAM peak is 2,813/6,141MB (45.8%); not full G4.
- Latest compiled IR audit passes for both VM precisions and all nine metric
  kernels, with no atomic instructions. IR SHA256:
  `a08afc1ae5c89fc2c33446b9ff6e1c0fd2d80abe3dd90a3c2ea131c7d9b94e7f`.
- The same 3,000-token training parity now has two failing composites, relative
  errors 8.175e-6 and 6.439e-9. Keep the 1e-9 threshold. No full G2 claim; M2
  must fix these as well as extending coverage to features/WF/strict/champions.
- Independent f64 m1.5 M1 performance also passes five rounds: CPU
  29.763–44.111s, native 2.855–3.231s, ratios 10.424–14.029x. Each round has
  identical 2,515 valid candidates and multiplicity. Both reports use the same
  70,174 bars, 49,122 training bars and 3,000 original JS-generated candidates.
  Setup/feature computation is excluded from the timed training eval segment;
  IPC, synchronization and readback are included. No 100-generation G3 claim.
- M1 exit achieved at `native-gpu-v1-m1.5`: both real performance reports and
  G1 pass. Latest 10 TS tests, 3 Rust tests and benchmark typecheck pass.
  Native suite: 26 passed. Original regression baseline still has the two idb
  version-expectation failures described above; they are not fixed or masked.
- Next milestone is M2. No release bump, push or tag has begun. Raw reports are
  in `.local-data/native-gpu-reports`.
