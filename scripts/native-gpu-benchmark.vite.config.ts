import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vite"
import desktopConfig from "../vite.config"

// Build the original worker exactly as a desktop release does. Vite's dev
// transform rejects dynamic imports from public/pyodide, unlike release assets.
export default mergeConfig(desktopConfig, defineConfig({
  build: {
    outDir: ".local-data/native-gpu-web",
    rollupOptions: { input: fileURLToPath(new URL("./native-gpu-benchmark.html", import.meta.url)) },
  },
}))
