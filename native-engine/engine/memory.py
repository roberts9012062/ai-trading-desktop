"""Allocation metadata only; shared resident arrays are counted once."""
import math


def resident_buffer_bytes(roots, describe=None):
    if describe is None:
        import taichi as ti
        def describe(value):
            if isinstance(value, ti.Ndarray):
                sizes = {ti.f64: 8, ti.f32: 4, ti.i64: 8, ti.i32: 4}
                if value.dtype not in sizes:
                    raise ValueError('Unsupported buffer dtype')
                return math.prod(value.shape)*math.prod(value.element_shape)*sizes[value.dtype]
            return None
    seen, total = set(), 0
    ignored = {'bars', 'all_bars', 'train_bars', 'test_bars', 'cfg', 'config', 'metadata', 'feature_host'}
    def visit(value):
        nonlocal total
        identity = id(value)
        if identity in seen:
            return
        seen.add(identity)
        size = describe(value)
        if size is not None:
            total += size
        elif isinstance(value, dict):
            for key, item in value.items():
                if key not in ignored:
                    visit(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                visit(item)
        elif type(value).__module__.startswith('engine.') and hasattr(value, '__dict__'):
            visit(vars(value))
    visit(roots)
    return total


def session_buffer_mb(session):
    roots = [session.vm, session.coarse_vm, session.metrics, session.strict_context,
             session.dedup_context, session.joint_context, session.regime_inputs,
             session.prepared['resident_full'], session.prepared['matrix']]
    return resident_buffer_bytes(roots)/(1024*1024)


def reserved_static_bytes(full_length, features=62):
    # Full feature matrix, bounded context/report/peer caches, training series
    # archive, and room for WebView/driver allocations. Batch VM/metrics are
    # budgeted separately by plan_tile. The 128 cap leaves 70k performance intact.
    return features*full_length*8 + (256+64+24+512)*1024*1024
