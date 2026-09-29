/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vite"
import desktopConfig from "../vite.config"

// Build the original worker exactly as a desktop release does. Vite's dev
// transform rejects dynamic imports from public/pyodide, unlike release assets.
export default mergeConfig(desktopConfig, defineConfig({
  build: {
    outDir: ".local-data/native-gpu-web",
    rollupOptions: { input: {
      benchmark: fileURLToPath(new URL("./native-gpu-benchmark.html", import.meta.url)),
      reference: fileURLToPath(new URL("./native-gpu-reference.html", import.meta.url)),
      generations: fileURLToPath(new URL("./native-gpu-generations.html", import.meta.url)),
    } },
  },
}))
