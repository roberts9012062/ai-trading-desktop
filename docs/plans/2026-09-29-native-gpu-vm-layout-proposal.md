# Native GPU VM execution layout proposal

Status: product confirmed on 2026-09-29: “允许调整执行布局（推荐）”.
This is an approved exception to the single-workgroup-per-candidate layout in
design §2.1; implementation and verification remain in M2.
The sole design document remains unchanged.

## Measured reason

Real ETHUSDT perpetual 15m, 70,174 bars, population 3,000, initial seed 42:

| Snapshot | Generation 1 | Rank | Strict | Enrichment | GPU utilization |
|---|---:|---:|---:|---:|---:|
| M2.14 | 6.89s | 2.73s | 1.49s | 2.56s | 61.32% |
| M2.17 | 6.35s | 2.65s | 1.40s | 2.18s | 56.69% |
| M2.18 | 6.12s | 2.75s | 1.09s | 2.17s | 58.15% |
| M2.19 | 6.27s | 3.16s | 1.12s | 1.88s | 60.88% |

All these runs pass startup G1 and fail the 2.5s generation gate. They are
three-generation diagnostics, not 100-generation G3 acceptance.
The shared-window optimization is byte-equivalent in tests but is slower in
this measured scenario. FP32 compensated expression moments also did not
reduce rank time materially. Current VM work remains in one 256-thread block
per candidate, interpreting the entire token sequence over the full calendar.

## Proposed change requiring confirmation

Use a grid of **candidate × time block** for each instruction. Keep the same
RPN stack machine, operator codes, nine stack slots and 256 threads per block.
Each instruction completes over all time blocks before the next instruction.
This adds kernel boundaries in place of the original per-candidate barriers.

1. Validate tokens and decode stack indices on the host: pure control metadata
   `(opcode, source_a, source_b, destination, rolling, active)` for each step.
2. Dispatch the current instruction over all candidate/time blocks. Read the
   original input stack and write the same destination/scratch slot.
3. For rolling operators, copy scratch back in a subsequent kernel after all
   output blocks finish. No overlapping source mutation during window reads.
4. For f64 prefix operators, retain the existing fixed ascending prefix scan
   before their evaluation kernel. Do not replace it with a reordered scan.
5. Retain the existing fixed 256-lane raw-mean/std tree, near-constant rule,
   normalization arithmetic, libm ports and metric/report reductions.

More time blocks can run independently on all SMs. The proposal needs a real
benchmark; it does not claim that this layout will achieve 2.5s.

## Reviewable interfaces and files

New `native-engine/engine/phase_vm_ti.py`:

```python
def decode_instruction_rows(candidates, feature_count):
    # CPU parsing only; no factor/statistic/price arithmetic.
    ...

class PhaseProgram:
    def dispatch(self, vm, candidates, *, normalize=True):
        ...
```

Existing native-only `StackVM` receives an internal `execution_layout`
option (`candidate_block` / `candidate_time_block`). Its public
`dispatch(candidates, normalize=...)` and `execute_batch(...)` signatures
remain compatible. The original implementation remains a numerical oracle.
Session and IPC payloads keep their current interfaces.

Additional kernels: instruction evaluation, rolling scratch copy, prefix
dispatch, raw tree statistics and final normalization. Existing arithmetic
functions are reused; expression results remain on the GPU. Instruction
metadata adds at most 128 × 32 × 6 × 4 bytes per tile.

## Required verification before changing the default

- Direct factor bytes versus the retained original layout in both precisions,
  including all operators, halo/tail boundaries, leading NaNs, discontinuities,
  extreme values, both normalization profiles and sealed prefixes.
- Startup 20-token double runs in both layouts; failed selfcheck refuses
  availability. Add every new kernel to the compiled-IR atomic audit.
- Complete current 56-record G2 and repeat complete G2 after the change.
  Composite relative difference stays <1e-9, champions >=99%, strict >=99.9%.
- Full 3,000 × 100 G3 with every generation <=2.5s and full-wall-time sampled
  GPU utilization >=60%. No warm candidate scores or omitted final reports.
- Retain device-profile limits and <70% VRAM, and all old-engine regressions.

M2 remains the current milestone. M3 integration and M4 release start only
after the required M2 exits pass.
