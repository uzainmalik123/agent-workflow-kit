import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // The untrusted-repository fixture under `fixtures/opencode-plugin-repo/` is deliberately not
    // part of the build. Its `.opencode/plugins/evil.ts` claims the trusted `opencode.*` namespace
    // and must never be compiled, imported, or linted as project code: the point of it is to be
    // refused on sight by the adapter's preflight, which decides from the path and the file's
    // existence, never by parsing or running it. TypeScript's include globs skip dot-directories,
    // so `fixtures/**/*.ts` never matched it in the first place; this ignore makes that exclusion
    // explicit for the typed linter rather than leaving it as an accident.
    ignores: [
      "**/coverage/**",
      "**/dist/**",
      "fixtures/opencode-plugin-repo/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
