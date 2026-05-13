import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["main.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // This plugin is plain CommonJS — Obsidian loads it via require().
      // The recommended config assumes the standard TS-source template.
      "@typescript-eslint/no-require-imports": "off",
      "no-implicit-globals": "off",
      // The recommended config declares Plugin/Setting/etc. as globals (for TS);
      // we destructure them from require("obsidian") which conflicts harmlessly.
      "no-redeclare": "off",
      // Allow `_` as the canonical name for an intentionally-unused catch binding.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Popout-window defensiveness via ownerDocument is irrelevant here: the
      // plugin only touches search leaves, which Obsidian doesn't permit in
      // popout windows. The timer-prefix form is cheap enough to keep on.
      "obsidianmd/prefer-active-doc": "off",
      // Always brace if/else/for/while bodies, no single-statement bodies.
      curly: ["error", "all"],
    },
  },
  {
    ignores: ["node_modules/**", "test/**", "vitest.config.js", "eslint.config.mjs"],
  },
];
