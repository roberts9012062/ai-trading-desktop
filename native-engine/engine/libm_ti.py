"""CUDA port of the bundled desktop's Emscripten 3.1.58 musl math.

exp/pow: Copyright (c) 2018, Arm Limited. SPDX-License-Identifier: MIT.
log1p/expm1: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
Developed at SunPro, a Sun Microsystems, Inc. business. Permission to use,
copy, modify, and distribute this software is freely granted, provided that
this notice is preserved. See THIRD_PARTY_LIBM.txt for source coordinates.

Explicit barriers preserve WebAssembly f64 operations without CUDA FMA
contraction. Restricted exp/expm1 paths cover clipped VM sigmoid/tanh inputs;
pow is restricted to the frozen third/fourth central moments.
"""
import json
from pathlib import Path

import numpy as np
import taichi as ti

_libm = None


def native_libm():
    global _libm
    if _libm is None:
        _libm = NativeLibm()
    return _libm


@ti.data_oriented
class NativeLibm:
    def __init__(self):
        values = json.loads((Path(__file__).with_name('exp_table.json')).read_text())
        self.exp_table = ti.field(ti.u64, shape=256)
        self.exp_table.from_numpy(np.array([int(x, 16) for x in values], dtype=np.uint64))
        rows = json.loads(Path(__file__).with_name('pow_table.json').read_text())
        self.pow_table = ti.field(ti.f64, shape=(128, 3))
        self.pow_table.from_numpy(np.array([[float.fromhex(x) for x in row] for row in rows], dtype=np.float64))
        self.pow_poly = tuple(float.fromhex(x)*scale for x, scale in (
            ('-0x1p-1', 1), ('0x1.555555555556p-2', -2), ('-0x1.0000000000006p-2', -2),
            ('0x1.999999959554ep-3', 4), ('-0x1.555555529a47ap-3', 4),
            ('0x1.2495b9b4845e9p-3', -8), ('-0x1.0002b8b263fc3p-3', -8)))
        self.pow_ln2hi = float.fromhex('0x1.62e42fefa3800p-1')
        self.pow_ln2lo = float.fromhex('0x1.ef35793c76730p-45')

    @ti.func
    def rounded(self, value, guard):
        return ti.bit_cast(ti.bit_cast(value, ti.i64)^guard, ti.f64)

    @ti.func
    def add(self, a, b, guard):
        return self.rounded(a+b, guard)

    @ti.func
    def sub(self, a, b, guard):
        return self.rounded(a-b, guard)

    @ti.func
    def mul(self, a, b, guard):
        return self.rounded(a*b, guard)

    @ti.func
    def divide(self, numerator, denominator, guard):
        d = self.rounded(denominator, guard)
        q = self.rounded(numerator/d, guard)
        product = self.mul(q, d, guard)
        qh = ti.bit_cast(ti.bit_cast(q, ti.i64)&ti.cast(-134217728, ti.i64), ti.f64)
        dh = ti.bit_cast(ti.bit_cast(d, ti.i64)&ti.cast(-134217728, ti.i64), ti.f64)
        ql, dl = self.sub(q, qh, guard), self.sub(d, dh, guard)
        error = self.sub(self.mul(qh, dh, guard), product, guard)
        error = self.add(error, self.mul(qh, dl, guard), guard)
        error = self.add(error, self.mul(ql, dh, guard), guard)
        error = self.add(error, self.mul(ql, dl, guard), guard)
        residual = self.sub(self.sub(numerator, product, guard), error, guard)
        return self.add(q, self.rounded(residual/d, guard), guard)

    @ti.func
    def exp(self, x, guard):
        result = ti.cast(1.0, ti.f64)
        if ti.abs(x)<5.551115123125783e-17:
            result = self.add(1.0, x, guard)
        elif ti.abs(x)<512.0:
            z = self.mul(184.6649652337873, x, guard)
            kd = self.add(z, 6755399441055744.0, guard)
            ki = ti.bit_cast(kd, ti.u64)
            kd = self.sub(kd, 6755399441055744.0, guard)
            r = self.add(x, self.mul(kd, -0.005415212348111709, guard), guard)
            r = self.add(r, self.mul(kd, -1.2864023111638346e-14, guard), guard)
            index = ti.cast(2*(ki%ti.u64(128)), ti.i32)
            top = ki << 45
            tail = ti.bit_cast(self.exp_table[index], ti.f64)
            scale = ti.bit_cast(self.exp_table[index+1]+top, ti.f64)
            r2 = self.mul(r, r, guard)
            c23 = self.add(0.49999999999996786, self.mul(r, 0.16666666666665886, guard), guard)
            c45 = self.add(0.0416666808410674, self.mul(r, 0.008333335853059549, guard), guard)
            tmp = self.add(tail, r, guard)
            tmp = self.add(tmp, self.mul(r2, c23, guard), guard)
            tmp = self.add(tmp, self.mul(self.mul(r2, r2, guard), c45, guard), guard)
            result = self.add(scale, self.mul(scale, tmp, guard), guard)
        else:
            # Unreachable for the sigmoid opcode after its frozen clipping;
            # retain mathematical handling for diagnostic exceptional inputs.
            result = ti.exp(x)
        return result

    @ti.func
    def log1p(self, x, guard):
        bits = ti.bit_cast(x, ti.u64)
        hx = ti.cast(bits >> 32, ti.u32)
        result, f, c = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
        k, early = 1, 0
        if hx < ti.u32(0x3fda827a) or (hx >> 31) != 0:
            if hx >= ti.u32(0xbff00000):
                early = 1
                result = ti.cast(float('nan'), ti.f64)
                if x == -1.0:
                    result = ti.cast(float('-inf'), ti.f64)
            elif ti.abs(x)<1.1102230246251565e-16:
                early, result = 1, x
            elif hx <= ti.u32(0xbfd2bec4):
                k, f = 0, x
        elif hx >= ti.u32(0x7ff00000):
            early, result = 1, x
        if early == 0:
            if k != 0:
                u = self.add(1.0, x, guard)
                ubits = ti.bit_cast(u, ti.u64)
                hu = ti.cast(ubits >> 32, ti.u32)+ti.u32(0x3ff00000-0x3fe6a09e)
                k = ti.cast(hu >> 20, ti.i32)-0x3ff
                if k < 54:
                    if k >= 2:
                        c = self.sub(1.0, self.sub(u, x, guard), guard)
                    else:
                        c = self.sub(x, self.sub(u, 1.0, guard), guard)
                    c = self.divide(c, u, guard)
                hu = (hu & ti.u32(0x000fffff))+ti.u32(0x3fe6a09e)
                reduced = (ti.cast(hu, ti.u64)<<32)|(ubits&ti.u64(0xffffffff))
                f = self.sub(ti.bit_cast(reduced, ti.f64), 1.0, guard)
            hfsq = self.mul(self.mul(.5, f, guard), f, guard)
            s = self.divide(f, self.add(2.0, f, guard), guard)
            z = self.mul(s, s, guard)
            w = self.mul(z, z, guard)
            t1 = self.add(.22222198432149784, self.mul(w, .15313837699209373, guard), guard)
            t1 = self.mul(w, self.add(.3999999999940942, self.mul(w, t1, guard), guard), guard)
            t2 = self.add(.1818357216161805, self.mul(w, .14798198605116586, guard), guard)
            t2 = self.add(.2857142874366239, self.mul(w, t2, guard), guard)
            t2 = self.mul(z, self.add(.6666666666666735, self.mul(w, t2, guard), guard), guard)
            R = self.add(t2, t1, guard)
            dk = ti.cast(k, ti.f64)
            result = self.mul(s, self.add(hfsq, R, guard), guard)
            result = self.add(result, self.add(self.mul(dk, 1.9082149292705877e-10, guard), c, guard), guard)
            result = self.sub(result, hfsq, guard)
            result = self.add(result, f, guard)
            result = self.add(result, self.mul(dk, .6931471803691238, guard), guard)
        return result

    @ti.kernel
    def diagnostic(self, source: ti.types.ndarray(dtype=ti.f64, ndim=1), out: ti.types.ndarray(dtype=ti.f64, ndim=1), mode: ti.i32, guard: ti.i64):
        for t in range(source.shape[0]):
            if mode == 0:
                out[t] = self.exp(source[t], guard)
            elif mode == 1:
                out[t] = self.log1p(source[t], guard)
            elif mode == 2:
                out[t] = self.expm1(source[t], guard)
            elif mode == 3:
                out[t] = self.tanh(source[t], guard)
            elif mode == 4:
                out[t] = self.moment_power(source[t], 3, guard)
            else:
                out[t] = self.moment_power(source[t], 4, guard)

    @ti.func
    def expm1(self, original, guard):
        # SunPro/musl restricted to the VM tanh's [-60,60] domain. Every
        # arithmetic operation retains the bundled WASM evaluation order.
        x = original
        bits = ti.bit_cast(x, ti.u64)
        hx, negative = (bits >> 32) & ti.u64(0x7fffffff), bits >> 63
        result = x
        if negative != 0 and hx >= ti.u64(0x4043687a):
            result = -1.0
        elif hx >= ti.u64(0x3c900000):
            k, c = 0, ti.cast(0.0, ti.f64)
            if hx > ti.u64(0x3fd62e42):
                hi, lo = ti.cast(0.0, ti.f64), ti.cast(0.0, ti.f64)
                if hx < ti.u64(0x3ff0a2b2):
                    if negative == 0:
                        hi, lo, k = self.sub(x, .69314718036912381649, guard), 1.90821492927058770002e-10, 1
                    else:
                        hi, lo, k = self.add(x, .69314718036912381649, guard), -1.90821492927058770002e-10, -1
                else:
                    adjustment = ti.cast(.5, ti.f64)
                    if negative != 0:
                        adjustment = -.5
                    k = ti.cast(self.add(self.mul(1.442695040888963387, x, guard), adjustment, guard), ti.i32)
                    hi = self.sub(x, self.mul(ti.cast(k, ti.f64), .69314718036912381649, guard), guard)
                    lo = self.mul(ti.cast(k, ti.f64), 1.90821492927058770002e-10, guard)
                x = self.sub(hi, lo, guard)
                c = self.sub(self.sub(hi, x, guard), lo, guard)
            hfx = self.mul(.5, x, guard)
            hxs = self.mul(x, hfx, guard)
            r = self.add(4.00821782732936239552e-6, self.mul(hxs, -2.01099218183624371326e-7, guard), guard)
            r = self.add(-7.93650757867487942473e-5, self.mul(hxs, r, guard), guard)
            r = self.add(1.58730158725481460165e-3, self.mul(hxs, r, guard), guard)
            r = self.add(-3.33333333333331316428e-2, self.mul(hxs, r, guard), guard)
            r = self.add(1.0, self.mul(hxs, r, guard), guard)
            t = self.sub(3.0, self.mul(r, hfx, guard), guard)
            e = self.mul(hxs, self.divide(self.sub(r, t, guard), self.sub(6.0, self.mul(x, t, guard), guard), guard), guard)
            if k == 0:
                result = self.sub(x, self.sub(self.mul(x, e, guard), hxs, guard), guard)
            else:
                e = self.sub(self.sub(self.mul(x, self.sub(e, c, guard), guard), c, guard), hxs, guard)
                if k == -1:
                    result = self.sub(self.mul(.5, self.sub(x, e, guard), guard), .5, guard)
                elif k == 1:
                    if x < -.25:
                        result = self.mul(-2.0, self.sub(e, self.add(x, .5, guard), guard), guard)
                    else:
                        result = self.add(1.0, self.mul(2.0, self.sub(x, e, guard), guard), guard)
                else:
                    scale = ti.bit_cast(ti.cast(0x3ff+k, ti.u64) << 52, ti.f64)
                    if k < 0 or k > 56:
                        result = self.sub(self.mul(self.add(self.sub(x, e, guard), 1.0, guard), scale, guard), 1.0, guard)
                    else:
                        inverse = ti.bit_cast(ti.cast(0x3ff-k, ti.u64) << 52, ti.f64)
                        if k < 20:
                            result = self.mul(self.add(self.sub(x, e, guard), self.sub(1.0, inverse, guard), guard), scale, guard)
                        else:
                            result = self.mul(self.add(self.sub(x, self.add(e, inverse, guard), guard), 1.0, guard), scale, guard)
        return result

    @ti.func
    def tanh(self, original, guard):
        bits = ti.bit_cast(original, ti.u64)
        absolute = bits & ti.u64(0x7fffffffffffffff)
        x = ti.bit_cast(absolute, ti.f64)
        high = absolute >> 32
        result = x
        if high > ti.u64(0x3fe193ea):
            if high > ti.u64(0x40340000):
                result = 1.0
            else:
                t = self.expm1(self.mul(2.0, x, guard), guard)
                result = self.sub(1.0, self.divide(2.0, self.add(t, 2.0, guard), guard), guard)
        elif high > ti.u64(0x3fd058ae):
            t = self.expm1(self.mul(2.0, x, guard), guard)
            result = self.divide(t, self.add(t, 2.0, guard), guard)
        elif high >= ti.u64(0x00100000):
            t = self.expm1(self.mul(-2.0, x, guard), guard)
            result = self.divide(-t, self.add(t, 2.0, guard), guard)
        if bits >> 63 != 0:
            result = -result
        return result

    @ti.func
    def _pow_log(self, ix, guard):
        tmp = ix-ti.u64(0x3fe6955500000000)
        index = ti.cast((tmp >> 45)%ti.u64(128), ti.i32)
        k = ti.bit_cast(tmp, ti.i64) >> 52
        iz = ix-(tmp & ti.u64(0xfff0000000000000))
        z = ti.bit_cast(iz, ti.f64)
        invc, logc, logctail = self.pow_table[index, 0], self.pow_table[index, 1], self.pow_table[index, 2]
        zhi = ti.bit_cast((iz+ti.u64(1 << 31)) & ti.u64(0xffffffff00000000), ti.f64)
        zlo = self.sub(z, zhi, guard)
        rhi = self.sub(self.mul(zhi, invc, guard), 1.0, guard)
        rlo = self.mul(zlo, invc, guard)
        r = self.add(rhi, rlo, guard)
        kd = ti.cast(k, ti.f64)
        t1 = self.add(self.mul(kd, self.pow_ln2hi, guard), logc, guard)
        t2 = self.add(t1, r, guard)
        lo1 = self.add(self.mul(kd, self.pow_ln2lo, guard), logctail, guard)
        lo2 = self.add(self.sub(t1, t2, guard), r, guard)
        ar = self.mul(self.pow_poly[0], r, guard)
        ar2 = self.mul(r, ar, guard)
        ar3 = self.mul(r, ar2, guard)
        arhi = self.mul(self.pow_poly[0], rhi, guard)
        arhi2 = self.mul(rhi, arhi, guard)
        hi = self.add(t2, arhi2, guard)
        lo3 = self.mul(rlo, self.add(ar, arhi, guard), guard)
        lo4 = self.add(self.sub(t2, hi, guard), arhi2, guard)
        p = self.add(self.pow_poly[5], self.mul(r, self.pow_poly[6], guard), guard)
        p = self.add(self.add(self.pow_poly[3], self.mul(r, self.pow_poly[4], guard), guard), self.mul(ar2, p, guard), guard)
        p = self.add(self.add(self.pow_poly[1], self.mul(r, self.pow_poly[2], guard), guard), self.mul(ar2, p, guard), guard)
        p = self.mul(ar3, p, guard)
        lo = self.add(self.add(self.add(self.add(lo1, lo2, guard), lo3, guard), lo4, guard), p, guard)
        value = self.add(hi, lo, guard)
        tail = self.add(self.sub(hi, value, guard), lo, guard)
        return value, tail

    @ti.func
    def _pow_exp(self, x, xtail, negative, guard):
        result = ti.cast(1.0, ti.f64)
        if ti.abs(x) < 5.551115123125783e-17:
            result = self.add(1.0, x, guard)
            if negative != 0:
                result = -result
        elif ti.abs(x) >= 1024:
            result = ti.cast(float('inf'), ti.f64)
            if x < 0:
                result = 0.0
            if negative != 0:
                result = -result
        else:
            z = self.mul(184.6649652337873, x, guard)
            kd = self.add(z, 6755399441055744.0, guard)
            ki = ti.bit_cast(kd, ti.u64)
            kd = self.sub(kd, 6755399441055744.0, guard)
            r = self.add(x, self.mul(kd, -0.005415212348111709, guard), guard)
            r = self.add(r, self.mul(kd, -1.2864023111638346e-14, guard), guard)
            r = self.add(r, xtail, guard)
            index = ti.cast(2*(ki%ti.u64(128)), ti.i32)
            top = (ki+ti.cast(negative, ti.u64)*ti.u64(0x40000)) << 45
            tail = ti.bit_cast(self.exp_table[index], ti.f64)
            sbits = self.exp_table[index+1]+top
            r2 = self.mul(r, r, guard)
            c23 = self.add(.49999999999996786, self.mul(r, .16666666666665886, guard), guard)
            c45 = self.add(.0416666808410674, self.mul(r, .008333335853059549, guard), guard)
            temp = self.add(self.add(tail, r, guard), self.mul(r2, c23, guard), guard)
            temp = self.add(temp, self.mul(self.mul(r2, r2, guard), c45, guard), guard)
            if ti.abs(x) >= 512:
                if (ki & ti.u64(0x80000000)) == 0:
                    sbits = sbits-ti.u64(1009 << 52)
                    scale = ti.bit_cast(sbits, ti.f64)
                    result = self.mul(ti.bit_cast(ti.u64(0x7f00000000000000), ti.f64), self.add(scale, self.mul(scale, temp, guard), guard), guard)
                else:
                    sbits = sbits+ti.u64(1022 << 52)
                    scale = ti.bit_cast(sbits, ti.f64)
                    y = self.add(scale, self.mul(scale, temp, guard), guard)
                    if ti.abs(y) < 1:
                        one = ti.cast(1.0, ti.f64)
                        if y < 0:
                            one = -1.0
                        lo = self.add(self.sub(scale, y, guard), self.mul(scale, temp, guard), guard)
                        hi = self.add(one, y, guard)
                        lo = self.add(self.add(self.sub(one, hi, guard), y, guard), lo, guard)
                        y = self.sub(self.add(hi, lo, guard), one, guard)
                        if y == 0:
                            y = ti.bit_cast(sbits & ti.u64(0x8000000000000000), ti.f64)
                    result = self.mul(ti.bit_cast(ti.u64(0x0010000000000000), ti.f64), y, guard)
            else:
                scale = ti.bit_cast(sbits, ti.f64)
                result = self.add(scale, self.mul(scale, temp, guard), guard)
        return result

    @ti.func
    def moment_power(self, x, order: ti.template(), guard):
        # Only the frozen third/fourth central moments need pow. Port musl's
        # non-FMA log/exp algorithm instead of replacing pow with multiplies.
        ix = ti.bit_cast(x, ti.u64)
        absolute = ix & ti.u64(0x7fffffffffffffff)
        negative = ti.cast(0, ti.i32)
        if ti.static(order == 3):
            negative = ti.cast(ix >> 63, ti.i32)
        result = ti.cast(0.0, ti.f64)
        if absolute == 0:
            result = ti.bit_cast(ti.cast(negative, ti.u64) << 63, ti.f64)
        elif absolute >= ti.u64(0x7ff0000000000000):
            result = ti.abs(x)
            if negative != 0:
                result = -result
        else:
            if absolute >> 52 == 0:
                absolute = ti.bit_cast(self.mul(ti.abs(x), 4503599627370496.0, guard), ti.u64)-ti.u64(52 << 52)
            hi, lo = self._pow_log(absolute, guard)
            lhi = ti.bit_cast(ti.bit_cast(hi, ti.u64) & ti.u64(0xfffffffff8000000), ti.f64)
            llo = self.add(self.sub(hi, lhi, guard), lo, guard)
            ehi, elo = self.mul(order, lhi, guard), self.mul(order, llo, guard)
            result = self._pow_exp(ehi, elo, negative, guard)
        return result
