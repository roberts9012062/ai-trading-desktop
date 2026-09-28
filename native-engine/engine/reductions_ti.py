"""Explicit fixed CUDA block trees; prefix summaries merge in fixed pairs."""
import taichi as ti


@ti.func
def block_tree_sum(shared: ti.template(), lane, channels: ti.template()):
    ti.simt.block.sync()
    step = 128
    while step > 0:
        if lane < step:
            for k in ti.static(range(channels)):
                shared[lane, k] = shared[lane, k] + shared[lane + step, k]
        ti.simt.block.sync()
        step = step // 2


@ti.func
def compensated_add(total, correction, value):
    y = value - correction
    result = total + y
    return result, (result - total) - y


@ti.func
def clipped_sortino(total, downside_square, downside_count, count, periods):
    result = ti.cast(0, ti.f64)
    if count >= 2:
        mean = total / count
        if downside_count == 0:
            if mean > 0:
                result = 20.0
        else:
            sd = ti.sqrt(downside_square / downside_count)
            if sd >= 1e-9:
                result = ti.min(20.0, ti.max(-20.0, mean / sd * ti.sqrt(periods)))
    return result
