import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettierRecommended from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "artifacts/**",
      // ⚠️ VENDORED, and it must stay byte-identical across all eight bundled
      // repos — verified: the same blob `d4cd2718` in `aeo-backend`,
      // `aeo-frontend`, `aeo-howto-web` and here. Linting it would let this
      // repo's prettier reformat it and quietly end that identity, which is the
      // one property that makes "the same checker runs everywhere" true.
      "scripts/okf-check.mjs",
      "scripts/okf-check.test.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // `tsc` resolves every identifier and does it properly; the lint rule
      // duplicates it worse and reports false positives on type-only names.
      // typescript-eslint's own guidance is to turn it off for TypeScript.
      "no-undef": "off",

      // `any` is off in `aeo-backend` because of history. This repo has none, so
      // it stays on: every value here comes from a page nobody controls, and
      // `any` is exactly how an unvalidated parse result reaches a caller
      // looking like a checked one.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // A floating promise in a paid fetch pipeline is a request nobody waits
      // for and nobody counts.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Plain-JS tooling: no type information, so the type-checked rules cannot run.
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettierRecommended,
);
