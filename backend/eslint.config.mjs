import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { ignores: ["dist/**", "node_modules/**", "public/**", "learning/**"] },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", NodeJS: "readonly" },
    },
    rules: {
      // Existing source uses any and unused parameters extensively. Track these
      // as migration debt rather than mixing a source-wide refactor into setup.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["tests/**/*.cjs", "scripts/**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "readonly", process: "readonly", __dirname: "readonly" },
    },
  },
]);
