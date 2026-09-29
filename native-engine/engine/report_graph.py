"""Replay unchanged continuous-report kernels with one native submission."""
import taichi as ti


class ReportGraph:
    def __init__(self, report):
        if ti.__version__ not in ((1, 7, 4), '1.7.4'):
            raise RuntimeError('Report graph requires pinned Taichi 1.7.4')
        builder, args, program = ti.graph.GraphBuilder(), {}, report.program

        def scalar(name, dtype=ti.i32):
            if name not in args:
                args[name] = ti.graph.Arg(ti.graph.ArgKind.SCALAR, name, dtype)
            return args[name]

        def array(name, value):
            if name not in args:
                args[name] = ti.graph.Arg(ti.graph.ArgKind.NDARRAY, name, value.dtype, ndim=len(value.shape))
            return args[name]

        def dispatch(method, values, symbolic):
            primal = method._primal
            key = primal.ensure_compiled(method._kernel_owner, *values)
            builder._graph_builder.dispatch(primal.compiled_kernels[key], symbolic)

        source = array('source', report.source)
        # Compile by ndarray dtype/rank only; factors have positions' ABI.
        factors = array('factors', report.positions)
        positions, flows = array('positions', report.positions), array('flows', report.flows)
        summary, means = array('summary', report.summary), array('means', report.means)
        ics = array('ics', report.ics)
        draw_a, draw_b = array('draw_a', report.draw_a), array('draw_b', report.draw_b)
        count, lo, hi = scalar('count'), scalar('lo'), scalar('hi')
        guard, cost = scalar('guard', ti.i64), scalar('cost', ti.f64)
        periods, multiplier = scalar('periods', ti.f64), scalar('multiplier', ti.f64)
        dispatch(program._positions, (report.positions, report.positions, 0, 0, 0),
                 [factors, positions, count, scalar('mode_0'), guard])
        for mode in range(3):
            mode_arg = scalar(f'mode_{mode}')
            dispatch(program._flows, (report.source, report.positions, report.flows, 0, 0, report.T, .0003, mode, 1., 0),
                     [source, positions, flows, count, lo, hi, cost, mode_arg, multiplier, guard])
            dispatch(program._summary, (report.source, report.flows, report.summary, 0, 0, report.T, mode),
                     [source, flows, summary, count, lo, hi, mode_arg])
            if mode == 0:
                dispatch(program._means, (report.positions, report.source, report.means, 0, 0, report.T, 0),
                         [factors, source, means, count, lo, hi, guard])
                dispatch(program._centered, (report.positions, report.source, report.means, report.ics, 0, 0, report.T, 0),
                         [factors, source, means, ics, count, lo, hi, guard])
            dispatch(program._draw_blocks, (report.flows, report.draw_a, 0, 0, report.T, 0),
                     [flows, draw_a, count, lo, hi, guard])
            width, a, b, actual_a, actual_b, stage = report.B, draw_a, draw_b, report.draw_a, report.draw_b, 0
            while width > 1:
                width //= 2
                dispatch(program._merge_draw, (actual_a, actual_b, 0, width),
                         [a, b, count, scalar(f'merge_width_{stage}')])
                a, b, actual_a, actual_b = b, a, actual_b, actual_a
                stage += 1
            dispatch(program._finish, (report.summary, report.ics, actual_a, report.slice_outputs[mode], 0, report.T, report.T, 35040., mode),
                     [summary, ics, a, array(f'output_{mode}', report.slice_outputs[mode]), count,
                      scalar('n'), scalar('T'), periods, mode_arg])
        self.blocks = report.B
        self.graph = builder.compile()

    def run(self, report, factors, count, lo, hi, cost, periods):
        inputs = {'source': report.source, 'factors': factors, 'positions': report.positions,
                  'flows': report.flows, 'summary': report.summary, 'means': report.means,
                  'ics': report.ics, 'draw_a': report.draw_a, 'draw_b': report.draw_b,
                  'count': count, 'lo': lo, 'hi': hi, 'n': hi-lo, 'T': report.T,
                  'guard': 0, 'cost': float(cost), 'periods': float(periods), 'multiplier': 1.}
        for mode in range(3):
            inputs[f'mode_{mode}'] = mode
            inputs[f'output_{mode}'] = report.slice_outputs[mode]
        width, stage = self.blocks, 0
        while width > 1:
            width //= 2
            inputs[f'merge_width_{stage}'] = width
            stage += 1
        self.graph.run(inputs)
