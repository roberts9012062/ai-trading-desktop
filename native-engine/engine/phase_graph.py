"""Submit existing phase kernels through Taichi's native sequential graph.

Taichi 1.7.4's public graph compiler does not inject a data-oriented kernel's
template `self`. Use its already-compiled C++ kernel with the same GraphBuilder
dispatch interface instead. No SDK patch, numerical kernel or new reduction.
Compatibility is pinned and startup verifies the resulting factor bytes.
"""
import taichi as ti


class InstructionGraph:
    def __init__(self, vm):
        if ti.__version__ not in ((1, 7, 4), '1.7.4'):
            raise RuntimeError('Instruction graph requires the pinned Taichi 1.7.4 runtime')
        program = vm.phase
        self.authority = program.authority
        self.compensated = vm.compensated_coarse
        builder = ti.graph.GraphBuilder()
        args = {}

        def scalar(name, dtype=ti.i32):
            if name not in args:
                args[name] = ti.graph.Arg(ti.graph.ArgKind.SCALAR, name, dtype)
            return args[name]

        def array(name, value):
            if name not in args:
                args[name] = ti.graph.Arg(ti.graph.ArgKind.NDARRAY, name,
                    value.dtype, ndim=len(value.shape))
            return args[name]

        def dispatch(method, values, symbolic):
            primal = method._primal
            key = primal.ensure_compiled(method._kernel_owner, *values)
            builder._graph_builder.dispatch(primal.compiled_kernels[key], symbolic)

        rows, stack = array('rows', vm.phase_rows), array('stack', vm.stack)
        indices = array('indices', vm.phase_indices)
        features, prefix = array('features', vm.features), array('prefix', vm.prefix)
        factors, stats = array('factors', vm.factors), array('stats', vm.phase_stats)
        guard, count = scalar('guard', ti.i64), scalar('count')
        for step in range(32):
            step_arg = scalar(f'step_{step}')
            if self.authority:
                dispatch(program._phase_prefix, (0, step, 0, vm.phase_rows, vm.stack, vm.prefix),
                    [scalar(f'prefix_{step}'), step_arg, guard, rows, stack, prefix])
            dispatch(program._phase_instruction,
                (0, step, 0, vm.features, vm.phase_rows, vm.phase_indices, vm.stack, vm.prefix),
                [scalar(f'instruction_{step}'), step_arg, guard, features, rows, indices, stack, prefix])
            dispatch(program._phase_copy_scratch, (0, step, vm.phase_rows, vm.stack),
                [scalar(f'copy_{step}'), step_arg, rows, stack])
        dispatch(program._phase_statistics,
            (0, int(vm.legacy), vm.phase_rows, vm.stack, vm.phase_stats, vm.prefix),
            [count, scalar('legacy'), rows, stack, stats, prefix])
        if self.authority:
            dispatch(program._phase_prefix, (0, -1, 0, vm.phase_rows, vm.stack, vm.prefix),
                [scalar('normal_prefix'), scalar('normal_step'), guard, rows, stack, prefix])
        dispatch(program._phase_output,
            (0, 0, vm.norm_window, 0, vm.stack, vm.factors, vm.prefix, vm.phase_stats),
            [scalar('output'), scalar('normalize'), scalar('window'), guard, stack, factors, prefix, stats])
        if not self.authority:
            if self.compensated:
                terms = array('terms', vm.coarse_terms)
                dispatch(vm.program._coarse_terms, (0, 0, vm.stack, vm.coarse_terms),
                    [scalar('normal_count'), guard, stack, terms])
                dispatch(vm.program._normalize_compensated_coarse,
                    (0, vm.norm_window, 0, vm.stack, vm.factors, vm.prefix, vm.coarse_terms),
                    [scalar('normal_count'), scalar('window'), guard, stack, factors, prefix, terms])
            else:
                dispatch(vm.program._normalize_coarse,
                    (0, vm.norm_window, vm.stack, vm.factors, vm.prefix),
                    [scalar('normal_count'), scalar('window'), stack, factors, prefix])
        self.graph = builder.compile()

    def run(self, vm, rows, active_counts, *, normalize):
        count = len(rows)
        inputs = {'rows': vm.phase_rows, 'indices': vm.phase_indices, 'stack': vm.stack, 'features': vm.features,
            'prefix': vm.prefix, 'factors': vm.factors, 'stats': vm.phase_stats,
            'guard': 0, 'count': count, 'legacy': int(vm.legacy),
            'output': count if self.authority or not normalize else 0,
            'normalize': int(normalize), 'window': vm.norm_window}
        for step in range(32):
            inputs[f'step_{step}'] = step
            inputs[f'instruction_{step}'] = active_counts[step]
            inputs[f'copy_{step}'] = count if rows[:, step, 4].any() else 0
            if self.authority:
                ops = rows[:, step, 0]-64
                needs = ((ops >= 13) & (ops <= 17)) | (ops == 23) | ((ops >= 30) & (ops <= 32)) | (ops == 34) | ((ops >= 46) & (ops <= 49)) | (ops == 36)
                inputs[f'prefix_{step}'] = count if (needs & rows[:, step, 5].astype(bool)).any() else 0
        if self.authority:
            inputs.update(normal_prefix=count if normalize else 0, normal_step=-1)
        else:
            inputs['normal_count'] = count if normalize else 0
            if self.compensated:
                inputs['terms'] = vm.coarse_terms
        self.graph.run(inputs)
