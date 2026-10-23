import js from "../backend/node_modules/@eslint/js/src/index.js";
import tseslint from "../backend/node_modules/typescript-eslint/dist/index.js";
import { defineConfig } from "../backend/node_modules/eslint/lib/config-api.js";

export default defineConfig([
  { ignores: ["dist/**", "node_modules/**", "media/index.*", ".test-work/**", "artifacts/**"] },
  {
    files: ["src/**/*.ts", "webview-ui/src/**/*.ts", "webview-ui/src/**/*.tsx"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }] },
  },
  {
    files: ["tests/**/*.cjs", "scripts/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: { globals: { require: "readonly", module: "readonly", process: "readonly", __dirname: "readonly", console: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly", fetch: "readonly", window: "readonly", document: "readonly", sessionStorage: "readonly" } },
  },
]);
