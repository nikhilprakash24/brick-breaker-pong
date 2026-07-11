import { defineConfig, type Plugin } from "vite";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Config JSON under src/config/data is FETCHED at runtime, never bundled
 * (SPEC-3.13 §13.1: levels hot-edit without rebuild in dev). In dev, Vite
 * already serves project files; this plugin maps /config/data/* onto
 * src/config/data/* and copies the tree into dist/ on build so the same
 * fetch paths work in production.
 */
function serveConfigData(): Plugin {
  const srcDir = "src/config/data";
  return {
    name: "serve-config-data",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/config/data/")) {
          req.url = "/" + srcDir + req.url.slice("/config/data".length);
        }
        next();
      });
    },
    closeBundle() {
      const copyTree = (from: string, to: string): void => {
        mkdirSync(to, { recursive: true });
        for (const name of readdirSync(from)) {
          const f = join(from, name);
          const t = join(to, name);
          if (statSync(f).isDirectory()) copyTree(f, t);
          else if (name.endsWith(".json")) copyFileSync(f, t);
        }
      };
      copyTree(srcDir, "dist/config/data");
    },
  };
}

export default defineConfig({
  base: "./",
  build: { target: "es2020" },
  plugins: [serveConfigData()],
});
