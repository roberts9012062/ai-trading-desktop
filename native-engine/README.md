# Native GPU engine (M3 shipped, M4 packaging)

This implements `docs/native-gpu-engine-plan.md`, with product approval
for GPU f32 coarse ranking + GPU f64 authoritative recomputation. All precision
thresholds are retained. The original design file,
CPU/WebGPU engines and Python oracle are unchanged. M1 `2ae7e33`, M2 `ea26018`
and M3 `32ddba6` are complete: all acceptance gates passed at engine version
`native-gpu-v1-m3.2` (see docs/plans/2026-09-29-native-gpu-m3-verification.md;
G5 soak and G3 absolute-time are product-amended, recorded in that report).

## Packaged runtime (M4)

The installer embeds a self-contained runtime next to the app executable:
`native-engine/{python,site-packages,engine,VERSION}` plus the shared
`public/pykernel` modules. `python/python311._pth` pins the interpreter's
sys.path inside the package, so no system Python, PYTHONPATH or PYTHONHOME can
interfere. First launch compiles GPU kernels for ~2-4 minutes (G1 selfcheck);
the engine refuses to serve before the selfcheck passes and the desktop falls
back to the existing WebGPU/CPU engines with an explanatory message.

- Size: ~266MB unpacked / ~70MB installer (LZMA).
- Dependencies are frozen with hashes in `requirements-native.lock`; CI
  assembles via `scripts/assemble-native-engine.py` and writes MANIFEST.sha256.
- NVIDIA driver: validated on driver 617.14 (RTX 4050 Laptop). Non-NVIDIA or
  driver-less machines fall back automatically; a 2-3 driver version matrix
  could not be covered on this single machine and remains a stated limitation.
- Signing: the updater artifacts are minisign-signed (TAURI_SIGNING_PRIVATE_KEY
  in CI). The embedded python.exe is NOT Authenticode code-signed (no
  certificate available to this project); antivirus false positives on the
  sidecar are possible and documented in the release notes.

## User-visible behaviour

- Zero qualified champions is a legal outcome: only candidates passing the
  frozen strict/OOS-WF/sealed-holdout gates are published, with reasons shown.
- Sealed holdout is revealed once at the final generation; it never feeds
  evolution, backfill or reranking.
- Process loss retries automatically up to 3 times (D-1 token seeding), then
  pauses with a recoverable checkpoint; budgets survive pause/resume.

## Development setup (Windows PowerShell)

Use CPython 3.11, an NVIDIA CUDA driver and the desktop repository checkout.
The launcher deliberately accepts only `mixed` or `f64`, never executable paths.

```powershell
uv venv --python 3.11 .local-data/native-engine-venv
uv pip sync --python .local-data/native-engine-venv/Scripts/python.exe --require-hashes requirements-native.lock
$env:PYTHONPATH = "$PWD/native-engine"
.local-data/native-engine-venv/Scripts/python.exe -u -m engine --precision mixed
```

After successful G1 the process prints one authenticated ready record. Taichi
logs are not ready records. Rust owns the process, reads that record, and exposes
`native_engine_spawn(precision)`, `native_engine_status()` and
`native_engine_kill()`. Token-bearing records must not be copied into logs.

Regenerate dependencies reproducibly with:

```powershell
uv pip compile --generate-hashes --python-version 3.11 --python-platform windows native-engine/requirements.in -o requirements-native.lock
```

## Implementation

- `protocol.py`: authenticated JSON/msgpack envelopes and little-endian f64 bars.
- `server.py`: loopback random port, one ordered numerical executor, live heartbeat.
- `session.py`: immutable bars/configuration, resident VM/metrics, bounded tiling.
  Launches group similar rolling work internally; returned candidate order and
  duplicate multiplicity remain unchanged.
- `vm_ti.py`: 47 supported WGSL operators, f32/f64 stack, fixed window order.
  Programs are compiled once per dtype at startup; session dimensions and
  normalization settings are runtime arguments to avoid blocking heartbeat
  with another large LLVM compilation after the ready handshake. Prefix scans
  reuse shared storage and preload eight inputs while preserving each ascending
  addition and its f64 rounding.
- Mixed sessions use a separate f32 ranking VM and f64 authoritative VM. Coarse
  results contain scores only; authoritative metrics always identify f64 evaluation.
- `metrics_ti.py` / `reductions_ti.py`: training metrics on CUDA, f64/Kahan and
  fixed reduction trees. Startup-warmed programs take lengths, head trim, costs
  and annualization as runtime arguments. Host code formats result dictionaries
  and scalar penalties.
- `selfcheck.py`: 20 fixed tokens; normalized factors and raw metrics must repeat
  byte for byte. Failure prevents a ready handshake.
- `poc_features.py`: unchanged CPU feature oracle **only for M1 setup**.
- `series_ti.py` / `features_ti.py`: all 62 feature rows on GPU, availability,
  leading-missing masks and frozen resident prefixes.
- `libm_ti.py`: GPU f64 exp/log1p compatible with the pinned desktop WASM libm;
  exact reference vectors and source/license attribution are included. This
  fixes the two frozen M1 composite regressions without relaxing the 1e-9 gate.
- `wf_ti.py` / `strict_ti.py`: validation slices, execution/funding reports,
  walk-forward, live and cross-peer gates on resident GPU data.
- `selection_ti.py` / `precise_ti.py` / `joint_ti.py`: correlation dedup,
  robustness, DSR moments, regime reports, joint training, archives and sealed
  final holdout. Array arithmetic is GPU; original scalar sorting, threshold,
  metadata and formatting helpers are reused without changing the CPU oracle.

The sidecar supports one resident CUDA session. Native CPU evaluation and the
four WGSL unsupported operators remain unavailable. Backend/UI wiring and
distribution are later milestone work. This is not a released engine and does
not replace existing mining engines.

Bars retain the existing device-profile limits: 100,000 / 200,000 / 300,000.
Allocation planning caps candidate tiles and reports an actionable error when
even one candidate cannot fit. No candidate population or history is silently
shortened to make a benchmark pass.

## Verification

```powershell
.local-data/native-engine-venv/Scripts/python.exe -m unittest discover -s tests/native_engine -v
.local-data/native-engine-venv/Scripts/python.exe scripts/verify-native-gpu-determinism.py --out .local-data/native-gpu-reports/g1.json
pnpm exec vitest run src/lib/native-engine
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml native_engine
```

`verify-native-gpu-parity.py --stage eval` compares raw training composites to
the unchanged CPU oracle. Reports explicitly mark full G2 incomplete. The full
stage requires 7 symbols × 4 frames, both precisions, champions and strict verdicts;
zero-valued smoke composites do not certify mixed full G2. Mixed startup G1
checks both the coarse and authoritative passes.

Cold CUDA compilation can take 3–4 minutes on the benchmark machine. Native
startup has a bounded 300-second handshake window; G1 still computes all
mandatory double runs before availability. Startup time is recorded separately
from the product-approved 5-second full-generation performance gate.

`fetch-native-gpu-suite.py` freezes seven perpetual histories for supported
15m/30m/60m/1d frames. `export-native-gpu-reference.py` uses the unchanged
production desktop worker and eight-worker pool on the dedicated reference
page, verifying served CPU source hashes and frozen input/dependency identity.
`verify-native-gpu-parity.py --stage full --suite <manifest> --precision both`
certifies only a complete 56-record pass. Repeated `--case SYMBOL/FRAME` flags
allow early full-pipeline diagnostics and always leave `G2_complete` false.
The precise input order matches the frozen reference's eight-way round-robin
worker merge, so zero-composite ties use identical candidate order. Reports
stamp both CPU input/dependency identity and native numerical source hashes.

Frozen bundled-WASM math vectors cover exp/log1p, expm1/tanh and third/fourth
central-moment powers. These ports retain rank ties and zero signs in long
expressions; all numerical evaluation still runs on CUDA. The permissive source
licenses and pinned source coordinates are in `THIRD_PARTY_LIBM.txt`.
`export-native-gpu-training-reference.mjs` regenerates the real XRP plateau
cashflow fixtures using the unchanged bundled CPU scoring module. These tests
lock downside membership at zero, including signed zero, for training/reports;
source and WASM hashes prevent silently using another numerical reference.

`bench-native-gpu-generations.py` measures the full JS evolution + GPU coarse
ranking/f64 authority + strict/precise loop through real IPC. It records every
generation and weights nvidia-smi utilization over all mining wall time,
including CPU/IPC gaps. A shortened `--generations` run cannot certify G3.

Private coarse normalization uses the design's f32 two-sum compensation option:
each f64 square is computed once and represented by two f32 components, then
window terms are accumulated in ascending order. Extreme-value overflow uses
the retained f64 window implementation. Published metrics always use the
separate f64 authoritative VM. Startup double-runs both coarse paths; temporary
expansion buffers are included in the device tile budget.

Private coarse positions use f32 tanh before the fixed f64 statistics. The
metrics API rejects this option for authoritative evaluation. Published
positions, cashflows and reports retain the f64 libm path. Selected champions'
frozen slices are batched without writing segment-cache entries; original
scalar calls still determine cache aliases, insertion and LRU order.

Private rolling expression moments and regression use ascending f32 two-sum
with Dekker product expansions. Extreme/subnormal/nonfinite inputs fall back
to the original f64 intermediate implementation. This is a private ranking
option: the authoritative f64 program ignores it. Startup also double-runs
the retained original coarse program as a numerical oracle.

The approved M2.20 instruction layout is selectable internally with
`StackVM(..., execution_layout="candidate_time_block")`. It decodes only token
control metadata on the host, dispatches each instruction over candidate/time
blocks, then copies rolling scratch after the instruction completes. Ordered
f64 prefix scans and the original 256-lane raw statistic trees are retained.
Startup double-runs both layouts and checks their factor bytes; all five new
kernels are included in the compiled-IR atomic audit. Direct byte tests pass
and the instruction layout is the M2.20 default for performance measurement.
The original layout remains selectable as `candidate_block`.

Full M2.19 G2 passes all 56 records (seven symbols, four periods, both modes),
with source hashes rechecked at completion. This certifies the M2.19 snapshot.
M2.25 also passes full G2, 56/56, with hashes rechecked at completion.
M2.28 passes complete two-layer G2, 56/56, with source hashes rechecked.
Both engines yield 14 qualified champions; raw/qualified overlaps and strict
agreement are 100%. All composite gates retain true relative error <1e-9.
The 130-test native suite and both-mode G1/40-kernel atomic audit also pass.
M2.28 also passes the real 100-generation mixed G3: max 4.5971s, median
1.54435s, mean 1.885782s, sampled GPU utilization 76.394%, coverage 100%,
VRAM peak 2,539/6,141 MiB (41.35%). Final generation takes 1.6464s.
The final research candidate fails strict/WF/holdout qualification; zero
qualified champions are published. Numeric workload is still executed.
Report: `.local-data/native-gpu-reports/g3-mixed-m2.28-100-r1.json`.

M2.21 retains the same numerical layout and fixes CUDA resource lifetime.
The WS thread borrows the numerical executor's context so CPython GC can
release Taichi ndarrays safely. Runtime teardown runs on the numerical owner
after disposal, collection and WS-context unbinding. Automatic GC is suspended
only across context transitions; normal mining retains normal GC.

M2.22 replays those exact kernels through Taichi's native sequential graph.
The adapter uses already-compiled class kernels from pinned Taichi 1.7.4,
without modifying the SDK. Graph and direct submissions match factor bytes
across operators, profiles, batch counts and frozen prefixes.

M2.23 retains batch scratch only within the existing frozen-context budget.
Input identity and width must match; scoring/cache admission order is untouched.
M2.24 packs active original row ids so completed candidates consume no further
instruction work. Both additions require fresh G2/G3 verification.

Product amendments confirmed on 2026-09-29: G3 is now <=5 seconds for every
one of 100 generations; sustained GPU utilization remains >=60%. G2 still
requires composite relative error <1e-9 and strict agreement >=99.9%.
The qualification amendment retains original research candidates for parity
and publishes only qualified champions. G2 compares both the research set and
the qualified set (same gate on both engines) at >=99% overlap.

M2.26 submits unchanged continuous-report kernels through a native sequential
graph; six direct/graph report tests pass. M2.27 adds task-dependent champion
qualification and task-owned strict proofs. Failed, exploratory, missing OOS
WF evidence, and failed final holdout candidates cannot become qualified
champions. No DSR/PBO/turnover threshold is invented. Pending final holdout
is separate from public champions. Qualification never reranks or backfills
against sealed data, and `best_seen` remains a training-only archive.
M2.28 records exact native engine versions and excludes stale or non-f64
inputs from seed archives. The new two-layer G2 must include actual
qualified reference candidates; an entirely empty qualified suite cannot pass.

Fetch the real 70,174-bar ETHUSDT 15m perpetual fixture with
`python scripts/fetch-native-gpu-benchmark.py`. Archives are checked against
Binance's SHA256 CHECKSUM files; the resulting manifest records provenance.

Use Python with Playwright installed. Build the benchmark with
`pnpm exec vite build --config scripts/native-gpu-benchmark.vite.config.ts`, then
serve it with `pnpm exec vite preview --config scripts/native-gpu-benchmark.vite.config.ts
--host 127.0.0.1 --port 4201 --strictPort`. Run `scripts/bench-native-gpu.py --url
http://127.0.0.1:4201 --bars .local-data/bench-bars/ETHUSDT-15m-perp-70174.json
--precision mixed --out .local-data/native-gpu-reports/m1-mixed.json`.
The dedicated HTML harness avoids application login redirects. Production worker
assets avoid Vite dev's restriction on public-directory dynamic imports. When
using a server helper, redirect Vite output to a file to avoid undrained pipes.
Every rebuilt browser test must use a new port. Repeat separately for f64.

The benchmark uses the original eight-worker shard pool and original JS random
tree generator, the same bars/configuration and 3,000 tokens for both engines,
five timed rounds including IPC and synchronization. It records raw results and
200ms `nvidia-smi` samples. Coverage/multiplicity mismatch in any round or any
round below 8× fails M1.
