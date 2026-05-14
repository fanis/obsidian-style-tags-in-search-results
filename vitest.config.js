import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.js"],
  },
  resolve: {
    alias: {
      // main.ts imports the real `obsidian` types package, which ships no
      // runtime. Tests resolve it to a minimal runtime stub instead.
      obsidian: fileURLToPath(new URL("./test/obsidian-stub/index.cjs", import.meta.url)),
    },
  },
});
