/** Regenerate plateau goldens with the unchanged bundled desktop CPU kernel. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadPyodide } from '../public/pyodide/pyodide.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtime = path.join(root, '.local-data/native-pyodide-reference')
fs.mkdirSync(runtime, { recursive: true })
fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"commonjs"}')
for (const name of fs.readdirSync(path.join(root, 'public/pyodide'))) {
  fs.copyFileSync(path.join(root, 'public/pyodide', name), path.join(runtime, name))
}
const fixturePath = path.join(root, 'tests/native_engine/fixtures/training-zero-pyodide.json')
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
const py = await loadPyodide({ indexURL: runtime + path.sep })
await py.loadPackage('numpy')
py.FS.mkdirTree('/oracle/factor_lab/scoring')
for (const name of ['/oracle/factor_lab/__init__.py', '/oracle/factor_lab/scoring/__init__.py']) {
  py.FS.writeFile(name, '')
}
const sourcePath = 'public/pykernel/factor_lab/scoring/evaluate.py'
const source = fs.readFileSync(path.join(root, sourcePath))
py.FS.writeFile('/oracle/factor_lab/scoring/evaluate.py', source)
py.globals.set('fixture_json', JSON.stringify(fixture))
const result = JSON.parse(py.runPython(`
import json, sys, numpy as np
sys.path.insert(0, '/oracle')
from factor_lab.scoring.evaluate import position_from_factor, next_ret
fixture = json.loads(fixture_json)
for case in fixture['cases']:
    arrays = {key: np.array([int(x) for x in case[key]], dtype=np.uint64).view(np.float64)
              for key in ('factor', 'close')}
    positions = position_from_factor(arrays['factor'])
    turnovers = np.abs(positions - np.concatenate(([0.0], positions[:-1])))
    pnl = positions * next_ret(arrays['close']) - turnovers * fixture['cost']
    for key, values in (('positions', positions), ('turnovers', turnovers), ('pnl', pnl)):
        case[key] = [str(int(x)) for x in values.view(np.uint64)]
json.dumps(fixture)
`))
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
result.pyodide = JSON.parse(fs.readFileSync(path.join(root, 'public/pyodide/pyodide-lock.json'))).info.version
result.wasm_sha256 = sha256(fs.readFileSync(path.join(root, 'public/pyodide/pyodide.asm.wasm')))
result.source_sha256 = { [sourcePath]: sha256(source) }
fs.writeFileSync(fixturePath, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ fixture: fixturePath, cases: result.cases.length, source_sha256: result.source_sha256 }))
