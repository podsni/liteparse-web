import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// LiteParse WASM is large and gzip-friendly. Configure asset handling so
// the .wasm file is fetched on demand (lazy init) and gzipped at edge.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5179,
    host: true,
  },
  preview: {
    port: 4179,
    host: true,
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable filenames for CDN caching.
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
        manualChunks: (id) => {
          if (id.includes("@llamaindex/liteparse-wasm")) return "liteparse-wasm";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["@llamaindex/liteparse-wasm"],
  },
  assetsInclude: ["**/*.wasm"],
});
