# M3 native GPU wiring — scope review

## Verified entry condition

M2 is committed at `ea26018`. M2.28 passes G1, 40/40 required compiled
kernel coverage with no atomic instructions, all 130 native tests, complete
two-layer G2 (56/56, 14 qualified champions per engine, 100% overlaps and
strict agreement), and real mixed G3 (100 generations, max 4.5971s,
GPU utilization 76.394%, VRAM 41.345%). Numeric sources remain unchanged.

New M3 files are already implemented and typechecked:

- `src/lib/native-engine/bars.ts`: f64 binary columns, original calendars,
  optional gaps and funding flags, unchanged device-profile bar guards.
- `src/lib/mining/backends/native-gpu-core.ts`: the existing JS evolution,
  native IPC only for all numerics, f64 qualified delivery, training archives,
  final-only holdout, generation-boundary pause, guaranteed session cleanup.
- `src/lib/mining/backends/native-gpu-backend.ts`: shared ComputeBackend
  facade, snapshot/direct entrances and owned connection cleanup.
- Seven initial host tests pass; benchmark/app TypeScript check passes.
  Recovery/fallback/desktop wiring and real integration tests remain open.

## Why two factory branches alone cannot finish the specified integration

The task restricts existing edits to additions at the specified connection
points. The current surrounding interfaces cannot represent a native choice:

- Device/engine enums contain only CPU/WebGPU; `resolveDevice` always probes
  WebGPU for non-CPU choices. Factory dispatch receives only that resolution.
- Both runners persist champions as D-1 seeds. Qualified native delivery can
  be empty while the separate training archive is nonempty.
- Factor-lab finalization unconditionally overwrites every kernel version
  with the old Pyodide version. Both finalizers compute portfolio statistics
  with Pyodide. Native results must retain their numerical origin.
- Factor-lab error handling recognizes only GPU→CPU; native interruption
  otherwise becomes failed. Its hook converts every non-WebGPU choice to CPU.
- History/favorite compatibility currently recognizes only the CPU kernel;
  valid native records would be classified as stale without native dispatch.

These are desktop dispatch/metadata boundaries, not old numerical algorithms.

## Proposed minimal additional existing connection points

All additions are guarded by native selection/provenance. Existing CPU/GPU
branches, score logic, evolution and old persistence behavior stay unchanged.
No edits to cpu-backend, gpu-backend, shard-pool, CPU Python kernels,
device-profile limits, old verify scripts or any server repository.

| Existing file | Native-only addition |
|---|---|
| `src/lib/mining/backends/types.ts` | Optional engine/version, training archive, recovery/qualification progress fields |
| `src/lib/mining/types.ts` | Native selection and precision/version config fields; hardware CPU/GPU distinction remains |
| `src/lib/mining/device.ts` | One native resolver delegation branch; existing CPU/WebGPU probe logic unchanged |
| `src/lib/mining/local-store.ts` | Optional native checkpoint/engine metadata fields |
| `src/lib/mining/local-runner.ts` | Native factory dispatch/config, D-1 training archive, version validation, native interruption/actual-engine updates and finalizer delegation |
| `src/lib/local-factor.ts` | Native engine/config type, factory/search branch, progress origin and native finalizer delegation before CPU stamping |
| `src/lib/mining/factor-lab-runner.ts` | Native training archive/checkpoint, interruption/engine metadata, pause guard and finalizer delegation |
| `src/components/factor-lab/hooks/use-factor-lab-page.ts` | Persist/select/pass native engine and precision without coercing it to CPU |
| `src/components/factor-lab/hooks/factor-helpers.ts` | Native version compatibility branch; existing records keep their original values |
| `src/components/factor-lab/history/history-panel.tsx` and `favorites/favorites-panel.tsx` | Native origin grouping/labels required by design §9 |
| §5's two pages and existing progress-card component | Native choice, precision control, availability reason, actual-engine and qualification/SM labels |

Signatures/extensions:

```ts
type LocalSearchEngine = "cpu" | "gpu" | "native-gpu"
type DeviceKind = "auto" | "cpu" | "gpu" | "native-gpu"
createSearchBackend(engine: LocalSearchEngine, options?: NativeLaunchOptions)
backendFactory(device: "cpu" | "gpu" | "native-gpu", config?: MiningConfig)
// All old caller arguments remain valid.
GenerationStep.bestSeen?: SerializedBest[]
GenerationStep.engineTag?: string
GenerationStep.engineVersion?: string
MiningConfig.native_precision?: "mixed" | "f64"
```

Native transport/lifecycle/qualification/portfolio helpers and new tests use
new files. Native portfolio finalization must use GPU f64 rather than silently
mixing Pyodide statistics into a native result. Its numerical additions get
CPU-oracle comparisons and renewed determinism/parity/performance checks.

## Recovery wording requiring a single interpretation

Design §2.2 specifies up to three automatic process restarts per task and
paused after exhaustion. G5 specifies killed processes reach a recoverable
pause; the user's completion definition also mentions the fallback chain.

Proposed interpretation:

- Initial CUDA/driver/capability/G1 failure: Native → WebGPU → CPU with
  accurate origin/reason. Requested-native delivery retains the same approved
  qualification rules around fallback outputs; direct old-engine tasks keep
  their current behavior. Archives of another numerical origin are never
  reused as scores; only tokens may be recomputed as D-1 seeds.
- Runtime process loss: resume from the last complete generation under D-1,
  up to three automatic restarts. Record the count per task across pause/
  resume. A fourth process loss pauses and preserves the checkpoint. G5
  verifies both successful recovery and exhausted-budget pause.
- Runtime confirmed driver/capability loss: use the fallback chain with
  origin reset, rather than retrying an unavailable CUDA backend.
- Manual pause/cancel remains at the generation boundary, without a sealed
  reveal or backfill. No exact-evolution-resume claim.

Status: product approved both the minimal native-only connection points and
the recovery interpretation on 2026-09-29. M3 core real verification passes
all complete/pause/dispose paths and 180 first-generation authority comparisons.
The full two-runner G5/G6 integration exit remains pending.
