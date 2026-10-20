import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import prefixSelector from "postcss-prefix-selector";
import { defineConfig } from "vite";

import { MIRAGON_RENDERERS } from "./src/notations/miragon/index.ts";
import { vendorCssScoping } from "./src/notations/miragon/vendor-css.ts";

// API + OAuth routes proxy to the live host, so cookies stay same-origin in
// dev exactly like in production (where the live host serves this app itself).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: {
      // one row per registered renderer: nothing to add here for a new one
      plugins: MIRAGON_RENDERERS.map((spec) => prefixSelector(vendorCssScoping(spec))),
    },
  },
  resolve: {
    alias: [
      // the dev preview of the Miragon widgets (`/mcp-app-miragon.html?notation=<id>`)
      // — the production bundles alias this to ONE spec each (vite.widget.config.ts)
      {
        find: "@/mcp-app/widget-spec",
        replacement: fileURLToPath(new URL("./src/mcp-app/widget-spec.dev.ts", import.meta.url)),
      },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  server: {
    proxy: {
      "/api": "http://localhost:8301",
      "/auth": "http://localhost:8301",
      "/setup": "http://localhost:8301",
      "/webhook": "http://localhost:8301",
      "/healthz": "http://localhost:8301",
    },
  },
});
