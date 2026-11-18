import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    // helix-ui is partially compiled: the services SettingsService injects need the JIT compiler in every test.
    setupFiles: ["src/test-setup.ts"],
  },
});
