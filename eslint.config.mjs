import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["main.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Always brace if/else/for/while bodies, no single-statement bodies.
      curly: ["error", "all"],
    },
  },
  {
    // main.js is the esbuild output, not source; everything else is tooling.
    ignores: [
      "node_modules/**",
      "test/**",
      "main.js",
      "esbuild.config.mjs",
      "vitest.config.js",
      "eslint.config.mjs",
    ],
  },
];
