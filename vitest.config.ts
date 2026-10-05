import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkgDirs = {
  core: "core",
  orchestration: "orchestration",
  persistence: "adapters/persistence",
  project: "adapters/project",
  workspace: "adapters/workspace",
  opencode: "adapters/opencode",
};

export default defineConfig({
  resolve: {
    alias: Object.entries(pkgDirs).map(([name, dir]) => ({
      find: new RegExp(`^@agent-workflow-kit/${name}$`),
      replacement: resolve(__dirname, dir, "src", "index.ts"),
    })),
  },
});