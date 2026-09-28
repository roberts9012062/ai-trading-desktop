# Native GPU M1 PoC

This implements M1 of `docs/native-gpu-engine-plan.md`, with product approval
for GPU f32 coarse ranking + GPU f64 authoritative recomputation. All precision
thresholds are retained. The original design file,
CPU/WebGPU engines and Python oracle are unchanged. Do not certify full G2 or
start M2 until G1 and the M1 real eight-worker performance gate pass.

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

## M1 implementation

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
  fixed reduction trees. Host code formats result dictionaries and scalar penalties.
- `selfcheck.py`: 20 fixed tokens; normalized factors and raw metrics must repeat
  byte for byte. Failure prevents a ready handshake.
- `poc_features.py`: unchanged CPU feature oracle **only for M1 setup**.

M1 supports one resident CUDA session. Native CPU evaluation, the four WGSL
unsupported operators, leading missing direct-data admission, joint training,
features on GPU, WF/strict/precise, backend/UI wiring and distribution are later
milestone work. Unsupported modes return explicit errors. This is not a released
engine and does not replace existing mining engines.

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
the unchanged CPU oracle. Reports explicitly mark full G2 incomplete. M2 must
extend this same script to 7 symbols × 4 frames, champions and strict verdicts;
zero-valued smoke composites do not certify mixed full G2. Mixed startup G1
checks both the coarse and authoritative passes.

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
