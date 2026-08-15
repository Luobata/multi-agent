import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { candidateWorkspaceSnapshot } from "../src/runtime/candidateRevision.js";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

function candidateRevisionPlugin(): Plugin {
  let cached: { expiresAt: number; revision: string } | undefined;
  return {
    name: "multi-agent-candidate-revision",
    configureServer(server) {
      server.middlewares.use((_request, response, next) => {
        void (async () => {
          if (!cached || cached.expiresAt < Date.now()) {
            const snapshot = await candidateWorkspaceSnapshot(workspaceRoot);
            cached = { revision: snapshot.revision, expiresAt: Date.now() + 500 };
          }
          response.setHeader("x-multi-agent-candidate-revision", cached.revision);
        })().then(next, next);
      });
    }
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../.vite-cache/client", import.meta.url)),
  plugins: [candidateRevisionPlugin(), react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: false,
    // dist also contains the server build, so Vite cannot empty the directory.
    // A per-build manifest lets the bundle gate ignore stale hashed client files.
    manifest: "client-manifest.json",
    rollupOptions: {
      output: {
        entryFileNames: "assets/app-[hash].js",
        chunkFileNames: "assets/route-[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4319,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/a2a": "http://127.0.0.1:4318"
    }
  }
});
