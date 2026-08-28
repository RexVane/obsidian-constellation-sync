import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "coverage/**", "*.mjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        __GITHUB_CLIENT_ID__: "readonly",
        __GITHUB_APP_SLUG__: "readonly",
        __GITHUB_INSTALL_URL__: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
);
