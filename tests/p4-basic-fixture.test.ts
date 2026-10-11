import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectVerificationProvider } from "@agent-workflow-kit/project";
import { describe, expect, it, afterEach } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "p4-basic");

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Task R.1 (P-22): the p4-basic fixture works out of the box for static and test.
 *
 * The fixture carries its own `package-lock.json` (made with
 * `npm install --package-lock-only` in a temp copy) so the package manager is
 * known without touching the framework's own pnpm setup. The test copies the
 * fixture to a temp dir — the provider must never run inside the repo fixture
 * itself — and asserts both stages pass.
 */
describe("p4-basic fixture verification", () => {
  it("passes static and test verification from a temp copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-p4-basic-"));
    roots.push(root);
    const copy = join(root, "p4-basic");
    await cp(fixture, copy, { recursive: true });

    const provider = new ProjectVerificationProvider({ projectRoot: copy });
    const stages = [
      { stage: "static_verification", verification: "static" },
      { stage: "test_verification", verification: "test" },
    ] as const;
    for (const { stage, verification } of stages) {
      const bundle = await provider.collect({
        projectRoot: copy,
        stage,
        verification,
        revision: 1,
        featureId: "F-001",
        workspaceId: "repo",
      });
      expect(bundle.outcome).toBe("passed");
      expect(bundle.checks.some((check) => check.status === "blocked")).toBe(false);
    }
  });
});
