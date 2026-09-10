import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    // No environment beyond Node, no setup files, no globals. Everything above
    // the fetcher is pure, so the suite needs neither a browser shim nor
    // credentials — which is what keeps the 53-row replay free to run.
    environment: "node",
  },
});
