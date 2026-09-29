/** Freeze actual bundled Pyodide/NumPy scalar libm vectors for GPU tests. */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { loadPyodide } from "../public/pyodide/pyodide.mjs"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// Pyodide 0.26's Node glue is CommonJS. This repository is an ESM package,
// so place an exact byte copy in an isolated CommonJS package for this test.
const runtime = path.join(root, ".local-data/native-pyodide-reference")
fs.mkdirSync(runtime, { recursive: true })
fs.writeFileSync(path.join(runtime, "package.json"), '{"type":"commonjs"}')
for (const name of fs.readdirSync(path.join(root, "public/pyodide"))) {
  fs.copyFileSync(path.join(root, "public/pyodide", name), path.join(runtime, name))
}
const py = await loadPyodide({ indexURL: runtime+path.sep })
await py.loadPackage("numpy")
const expInputs = Array.from({ length: 513 }, (_, i) => -30 + 60 * i / 512)
const logInputs = [...Array.from({ length: 513 }, (_, i) => -0.999 + 30 * i / 512),
  0, -0, 1e-16, -1e-16, 1e-30, 1e-9, 1e8, 1e20, 1e300]
const tanhInputs = [...expInputs, 0, -0, 1e-320, -1e-320, 1e-16, -1e-16,
  .25541281188299536, -.25541281188299536, .5493061443340549, -.5493061443340549, 20, -20]
py.globals.set("exp_json", JSON.stringify(expInputs))
py.globals.set("log_json", JSON.stringify(logInputs))
py.globals.set("tanh_json", JSON.stringify(tanhInputs))
py.globals.set("pow_json", JSON.stringify([...Array.from({length:513}, (_,i) => (i-256)/257),
  0, 1e-12, -1e-12, 1e-30, -1e-30, 1e-100, -1e-100, 1e100, -1e100]))
const vectors = JSON.parse(py.runPython(`
import json, numpy as np, sys
exp_inputs = np.asarray(json.loads(exp_json), dtype=np.float64)
log_inputs = np.asarray(json.loads(log_json), dtype=np.float64)
tanh_inputs = np.asarray(json.loads(tanh_json), dtype=np.float64)
pow_inputs = np.asarray(json.loads(pow_json), dtype=np.float64)
def vector(inputs, outputs):
 return [{'x': float(x), 'input_bits': str(int(i)), 'bits': str(int(y))}
  for x, i, y in zip(inputs, inputs.view(np.uint64), outputs.view(np.uint64))]
json.dumps({'python': sys.version.split()[0], 'numpy': np.__version__,
 'exp': vector(exp_inputs, np.exp(exp_inputs)),
 'expm1': vector(tanh_inputs, np.expm1(tanh_inputs)),
 'tanh': vector(tanh_inputs, np.tanh(tanh_inputs)),
 'pow3': vector(pow_inputs, pow_inputs ** 3),
 'pow4': vector(pow_inputs, pow_inputs ** 4),
 'log1p': vector(log_inputs, np.log1p(log_inputs))})
`))
const lock = JSON.parse(fs.readFileSync(path.join(root, "public/pyodide/pyodide-lock.json")))
// Exact input bits preserve subnormal values across WASM/JS JSON conversion.
vectors.pyodide = lock.info.version
vectors.wasm_sha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "public/pyodide/pyodide.asm.wasm"))).digest("hex")
const out = path.join(root, "tests/native_engine/fixtures/libm-pyodide.json")
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(vectors, null, 2)+"\n")
console.log(JSON.stringify({ pyodide: vectors.pyodide, python: vectors.python, numpy: vectors.numpy, exp: vectors.exp.length, log1p: vectors.log1p.length, tanh: vectors.tanh.length }))
