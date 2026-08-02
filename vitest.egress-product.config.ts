import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["vendor/sandbox-runtime/test/sandbox/update-config.test.ts"],
      setupFiles: ["./vitest.egress-product.setup.ts"],
    },
  }),
);
