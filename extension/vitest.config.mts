import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/**/*.spec.ts", "src/**/*.spec.ts"], environment: "node" },
});
