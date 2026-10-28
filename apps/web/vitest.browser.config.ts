import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

// The app's own Vite config: each renderer's stylesheet is scoped under its
// canvas class, as the SPA loads it.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["test/browser/**/*.browser.test.ts"],
      // the conformance kit's keys case moves the focus of the one page
      fileParallelism: false,
      browser: {
        enabled: true,
        provider: playwright(),
        headless: true,
        instances: [{ browser: "chromium" }],
      },
    },
  }),
);
