import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

/**
 * Local development only: serves Wren's hosted function at /api/wren from ../api/wren.ts, the same file
 * Vercel deploys. Her key comes from the environment or, on this machine, from Hardhat's vars store.
 */
function wrenDev(): Plugin {
  return {
    name: "wren-dev",
    configureServer(server) {
      const vars = join(process.env.APPDATA ?? "", "hardhat-nodejs", "Config", "vars.json");
      const stored = existsSync(vars) ? (JSON.parse(readFileSync(vars, "utf8")).vars ?? {}) : {};
      process.env.WREN_PRIVATE_KEY ??= stored.WREN_PRIVATE_KEY?.value;
      // A throwaway test player for ?devwallet, served only by this dev server and only to localhost.
      server.middlewares.use("/api/dev-wallet", (req, res) => {
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
        const key = stored.PLAYER_PRIVATE_KEY?.value;
        res.statusCode = local && key ? 200 : 404;
        res.end(local && key ? JSON.stringify({ key }) : "{}");
      });
      process.env.BLINDCUP_ADDRESS ??= "0x77A7a9eb769e63130E696a09C64c6E5F1DF58dbB";
      server.middlewares.use("/api/wren", async (req, res) => {
        try {
          const mod = await server.ssrLoadModule(resolve(__dirname, "../api/wren.ts"));
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const request = new Request("http://localhost/api/wren", {
            method: req.method,
            headers: { "content-type": "application/json" },
            body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
          });
          const r: Response = req.method === "POST" ? await mod.POST(request) : await mod.GET();
          res.statusCode = r.status;
          r.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(await r.text());
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [wrenDev()],
  optimizeDeps: { exclude: ["@zama-fhe/relayer-sdk"] },
  resolve: { alias: { "wasm-feature-detect": resolve(__dirname, "src/shims/wasm-feature-detect.ts") } },
  build: { target: "es2022" },
});
