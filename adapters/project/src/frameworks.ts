import type { NodePackageManager } from "./commands.js";

/**
 * Framework detection is a lookup, not an inference.
 *
 * The only evidence used is a package name appearing in a dependency section of a manifest, or a
 * well-known configuration file existing. Nothing reads or classifies source code, and nothing is
 * guessed from a directory name, so two runs over the same repository always produce the same list.
 */
export interface FrameworkDefinition {
  readonly label: string;
  /** The package whose presence in a manifest identifies the framework. */
  readonly packageName?: string;
  /** A file whose presence identifies the framework, for tools that ship no runtime package. */
  readonly markerFile?: string;
}

/**
 * Ordered by label. Sorted again after detection, so the result is a property of the repository
 * rather than of this table's order.
 */
export const FRAMEWORK_DEFINITIONS: readonly FrameworkDefinition[] = [
  { label: "angular", packageName: "@angular/core" },
  { label: "astro", packageName: "astro" },
  { label: "bun-test", packageName: "bun-types" },
  { label: "cypress", packageName: "cypress" },
  { label: "drizzle-orm", packageName: "drizzle-orm" },
  { label: "electron", packageName: "electron" },
  { label: "esbuild", packageName: "esbuild" },
  { label: "eslint", packageName: "eslint" },
  { label: "express", packageName: "express" },
  { label: "fastify", packageName: "fastify" },
  { label: "hono", packageName: "hono" },
  { label: "jest", packageName: "jest" },
  { label: "koa", packageName: "koa" },
  { label: "mocha", packageName: "mocha" },
  { label: "mongoose", packageName: "mongoose" },
  { label: "nestjs", packageName: "@nestjs/core" },
  { label: "next.js", packageName: "next" },
  { label: "nx", markerFile: "nx.json" },
  { label: "playwright", packageName: "playwright" },
  { label: "playwright", packageName: "@playwright/test" },
  { label: "prettier", packageName: "prettier" },
  { label: "prisma", packageName: "prisma" },
  { label: "react", packageName: "react" },
  { label: "react-native", packageName: "react-native" },
  { label: "remix", packageName: "@remix-run/react" },
  { label: "rollup", packageName: "rollup" },
  { label: "solid", packageName: "solid-js" },
  { label: "svelte", packageName: "svelte" },
  { label: "sveltekit", packageName: "@sveltejs/kit" },
  { label: "tailwindcss", packageName: "tailwindcss" },
  { label: "tsup", packageName: "tsup" },
  { label: "turborepo", markerFile: "turbo.json" },
  { label: "typeorm", packageName: "typeorm" },
  { label: "typescript", packageName: "typescript" },
  { label: "typescript-eslint", packageName: "typescript-eslint" },
  { label: "vite", packageName: "vite" },
  { label: "vitest", packageName: "vitest" },
  { label: "vue", packageName: "vue" },
  { label: "webpack", packageName: "webpack" },
  { label: "workspaces", markerFile: "pnpm-workspace.yaml" },
];

export function detectFrameworks(
  dependencyNames: ReadonlySet<string>,
  presentFiles: ReadonlySet<string>,
): readonly string[] {
  const found = new Set<string>();

  for (const definition of FRAMEWORK_DEFINITIONS) {
    const named =
      definition.packageName !== undefined && dependencyNames.has(definition.packageName);
    const marked =
      definition.markerFile !== undefined && presentFiles.has(definition.markerFile);

    if (named || marked) {
      found.add(definition.label);
    }
  }

  return [...found].sort();
}

/** The `devEngines.packageManager` and `packageManager` fields both name a manager, with a version. */
export function parseDeclaredPackageManager(value: string | null): NodePackageManager | null {
  if (value === null) {
    return null;
  }

  const name = value.split("@")[0]?.trim().toLowerCase() ?? "";

  return name === "pnpm" || name === "npm" || name === "yarn" || name === "bun" ? name : null;
}
