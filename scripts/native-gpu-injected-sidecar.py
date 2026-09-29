"""Developer-only fault harness; production engine sources stay untouched."""
import argparse
import ctypes
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'native-engine'))
p = argparse.ArgumentParser()
p.add_argument('--fault', choices=('none', 'no-driver', 'no-card', 'selfcheck'), default='none')
p.add_argument('--precision', choices=('mixed', 'f64'), default='mixed')
p.add_argument('--driver-marker', type=Path)
args = p.parse_args()

import engine.runtime as runtime
if args.fault == 'no-driver':
    original_loader = ctypes.WinDLL
    def unavailable(name, *positional, **kwargs):
        if str(name).lower() == 'nvcuda.dll':
            raise OSError('Injected NVIDIA driver unavailable')
        return original_loader(name, *positional, **kwargs)
    ctypes.WinDLL = unavailable
elif args.fault == 'no-card':
    original_loader = ctypes.WinDLL
    class NoCudaDevice:
        def cuInit(self, _flags): return 0
        def cuDeviceGet(self, _device, _ordinal): return 100  # CUDA_ERROR_NO_DEVICE
    def no_device(name, *positional, **kwargs):
        if str(name).lower() == 'nvcuda.dll': return NoCudaDevice()
        return original_loader(name, *positional, **kwargs)
    ctypes.WinDLL = no_device

from engine.server import EngineServer, main
if args.driver_marker is not None:
    original_dispatch = EngineServer.dispatch
    def driver_loss(self, message):
        if message['type'] not in ('dispose_session',) and args.driver_marker.is_file():
            from engine.protocol import ProtocolError
            raise ProtocolError('Injected NVIDIA driver lost during mining', 'DRIVER_UNAVAILABLE')
        return original_dispatch(self, message)
    EngineServer.dispatch = driver_loss
sys.argv = ['engine', '--precision', args.precision]
if args.fault == 'selfcheck': sys.argv.append('--inject-selfcheck-failure')
raise SystemExit(main())
