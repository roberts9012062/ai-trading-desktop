import config from "../vite.config"

export default {
  ...config,
  cacheDir: ".local-data/factor-backtest-vite-cache",
  optimizeDeps: { entries: ["scripts/factor-backtest-smoke.html"] },
  build: {
    ...config.build,
    outDir: ".local-data/factor-backtest-fixture",
    rollupOptions: { input: "scripts/factor-backtest-smoke.html" },
  },
}
