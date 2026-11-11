import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "examples/**"],
  },
];
