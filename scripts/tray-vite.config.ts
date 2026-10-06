import config from "../vite.config"

// Build a small, immutable fixture independent of the user's Vite preview.
export default {
  ...config,
  cacheDir: ".local-data/tray-vite-cache",
  optimizeDeps: { entries: ["scripts/tray-smoke.html"] },
  build: { ...config.build, outDir: ".local-data/tray-fixture", rollupOptions: { input: "scripts/tray-smoke.html" } },
  server: { ...config.server, host: "127.0.0.1", port: 5199, strictPort: true },
}
