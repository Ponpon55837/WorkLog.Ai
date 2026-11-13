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
    // Storage canonicalizes a project root (lowercase on Windows, resolved temp paths on macOS), so a test that
    // compares rootPath with the path it passed in passes on Linux and fails elsewhere. Use ids or names instead.
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name='rootPath']",
          message:
            "Do not compare rootPath with a raw path: storage canonicalizes roots per OS. Look projects up by id or name.",
        },
      ],
    },
  },
  {
    // Experiment scripts run under Node and use its globals directly.
    files: ["docs/experiments/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
    // Some scripts import `process` explicitly; that must not clash with the declared global.
    rules: { "no-redeclare": ["error", { builtinGlobals: false }] },
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
