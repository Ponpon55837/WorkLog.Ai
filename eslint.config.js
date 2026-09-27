import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";

// Declare before use: a const/let referenced above its declaration throws at runtime (temporal dead zone).
// Function declarations are hoisted, so they may sit below the code that calls them.
const declareBeforeUse = [
  "error",
  { functions: false, classes: true, variables: true, typedefs: false, ignoreTypeReferences: true },
];
const unusedVariables = [
  "error",
  {
    args: "after-used",
    argsIgnorePattern: "^_",
    caughtErrors: "none",
    varsIgnorePattern: "^_",
  },
];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/data/**",
      "**/test-results/**",
      "**/coverage/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-debugger": "error",
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": unusedVariables,
      "@typescript-eslint/no-use-before-define": declareBeforeUse,
    },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        parser: tseslint.parser,
      },
    },
    plugins: {
      vue,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-debugger": "error",
      "no-undef": "off",
      "no-unused-vars": "off",
      "vue/no-unused-vars": "error",
      "@typescript-eslint/no-unused-vars": unusedVariables,
      "@typescript-eslint/no-use-before-define": declareBeforeUse,
      // The rest of the <script setup> order is checked by scripts/sfc-layout.mjs (worklog-code-layout skill).
      "vue/define-macros-order": [
        "error",
        { order: ["defineOptions", "defineProps", "defineEmits", "defineModel", "defineSlots"] },
      ],
    },
  },
];
