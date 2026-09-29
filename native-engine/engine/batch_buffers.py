"""Budgeted data-only VM/report scratch; never cache scores or verdicts."""
from collections import OrderedDict


def _make_buffers(data, width):
    from factor_lab.market import is_v2
    from .vm_ti import StackVM
    vm = StackVM(data['features'].matrix, 'f64', tile=width,
        norm_window=data['vm'].norm_window,
        normalization='causal_v2' if is_v2(data['bars']) else 'legacy',
        bar_count=len(data['bars']))
    return vm, data['reports'].with_tile(width)


class BatchBufferPool:
    def __init__(self, limit_bytes, *, factory=_make_buffers):
        self.entries = OrderedDict()
        self.bytes = 0
        self.factory = factory
        self.set_limit(limit_bytes)

    @staticmethod
    def estimate_bytes(data, width):
        count = len(data['bars'])
        blocks = 1 << ((max(1, (count+1023)//1024)-1).bit_length())
        # Stack/factor/prefix=14 and report positions/flows=7 f64 rows.
        # Retained owner data is charged too, even while also in context LRU.
        overhead = width*(32*8*4+16+(8*blocks+64+2*11)*8)+16384
        return int(data['bytes'])+width*count*21*8+overhead

    def set_limit(self, limit_bytes):
        if type(limit_bytes) is not int or limit_bytes < 0:
            raise ValueError('Invalid batch buffer budget')
        self.limit = limit_bytes
        while self.entries and self.bytes > self.limit:
            _, entry = self.entries.popitem(last=False)
            self.bytes -= entry[2]

    def acquire(self, data, width):
        if type(width) is not int or not 1 <= width <= 16:
            raise ValueError('Invalid batch buffer width')
        key = (id(data), width)
        hit = self.entries.get(key)
        if hit is not None:
            self.entries.move_to_end(key)
            return hit[1]
        size = self.estimate_bytes(data, width)
        if size > self.limit:
            return self.factory(data, width)
        while self.entries and self.bytes+size > self.limit:
            _, entry = self.entries.popitem(last=False)
            self.bytes -= entry[2]
        buffers = self.factory(data, width)
        # Hold the exact input object: a later dict can never reuse its id.
        # Publish only after the complete VM/report pair exists.
        self.entries[key] = (data, buffers, size)
        self.bytes += size
        return buffers

    def dispose(self):
        self.entries.clear()
        self.bytes = 0
