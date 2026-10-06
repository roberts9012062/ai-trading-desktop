import { runPreparedFactorBacktest } from "../src/lib/local-factor-backtest"

Object.assign(window, { factorBacktestProbe: runPreparedFactorBacktest })
