import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// LiteParse WASM is large and gzip-friendly. Configure asset handling so
// the .wasm file is fetched on demand (lazy init) and gzipped at edge.
export default defineConfig({
  // Repo is served at https://podsni.github.io/liteparse-web/ via GitHub
  // Pages. Use the matching base so absolute asset paths resolve correctly.
  base: process.env["DEPLOY_TARGET"] === "gh-pages" ? "/liteparse-web/" : "/",
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
