"""Borrow the numerical thread's context for WS-thread ndarray finalizers.

Taichi 1.7.4 deletes ndarrays on the Python thread running their finalizer.
CUDA contexts are thread-local; CPython cyclic GC may run on the WS thread.
The lease only pushes/pops the existing context. It creates no new context
and performs no numerical work. The numerical executor owns runtime reset.
"""
import ctypes
import os
import threading


def _driver():
    driver = ctypes.WinDLL('nvcuda.dll') if os.name == 'nt' else ctypes.CDLL('libcuda.so.1')
    driver.cuCtxGetCurrent.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    driver.cuCtxGetCurrent.restype = ctypes.c_int
    driver.cuCtxPushCurrent_v2.argtypes = [ctypes.c_void_p]
    driver.cuCtxPushCurrent_v2.restype = ctypes.c_int
    driver.cuCtxPopCurrent_v2.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    driver.cuCtxPopCurrent_v2.restype = ctypes.c_int
    return driver


def capture_cuda_context():
    context = ctypes.c_void_p()
    status = _driver().cuCtxGetCurrent(ctypes.byref(context))
    if status != 0 or not context.value:
        raise RuntimeError(f'CUDA numerical context unavailable ({status})')
    return context.value


class CudaContextLease:
    def __init__(self, context):
        if type(context) is not int or not context:
            raise ValueError('Invalid CUDA context lease')
        self.driver = _driver()
        self.context = context
        self.thread = threading.get_ident()
        self.closed = False
        status = self.driver.cuCtxPushCurrent_v2(context)
        if status != 0:
            raise RuntimeError(f'Cannot bind CUDA finalizer context ({status})')

    def close(self):
        if self.closed:
            return
        if threading.get_ident() != self.thread:
            raise RuntimeError('CUDA lease must close on its binding thread')
        popped = ctypes.c_void_p()
        status = self.driver.cuCtxPopCurrent_v2(ctypes.byref(popped))
        if status != 0 or popped.value != self.context:
            raise RuntimeError(f'CUDA finalizer context stack changed ({status})')
        self.closed = True
