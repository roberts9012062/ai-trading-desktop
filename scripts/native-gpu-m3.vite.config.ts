import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vite"
import desktopConfig from "../vite.config"

export default mergeConfig(desktopConfig, defineConfig({ build: {
  rollupOptions: { input: { app: fileURLToPath(new URL("../index.html", import.meta.url)),
    nativeM3: fileURLToPath(new URL("./native-gpu-m3.html", import.meta.url)),
    nativeGenerations: fileURLToPath(new URL("./native-gpu-generations.html", import.meta.url)),
    nativePortfolio: fileURLToPath(new URL("./native-gpu-portfolio.html", import.meta.url)),
    nativeSoak: fileURLToPath(new URL("./native-gpu-soak.html", import.meta.url)) } },
  // The frozen G3 JS evolution harness shares this fresh build/port.
} }))
