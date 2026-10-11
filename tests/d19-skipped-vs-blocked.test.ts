import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectVerificationProvider } from "@agent-workflow-kit/project";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "p4-basic");

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function copyP4WithoutLockfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d19-"));
  roots.push(root);
  const copy = join(root, "p4-basic");
  await cp(fixture, copy, { recursive: true });
  await rm(join(copy, "package-lock.json"), { force: true });
  return copy;
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-d19-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return root;
}

function checkFor(bundle: { checks: readonly { id: string }[] }, id: string): { id: string } | undefined {
  return bundle.checks.find((c) => c.id === id);
}

describe("D-19: undeclared capabilities are skipped, declared ones stay blocked", () => {
  it("no build script plus no lockfile gives build skipped and static passes (p4-basic without lockfile)", async () => {
    const copy = await copyP4WithoutLockfile();
    const provider = new ProjectVerificationProvider({ projectRoot: copy });
    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: copy,
      workspaceId: null,
    });

    const build = checkFor(bundle, "build");
    expect(build).toMatchObject({ status: "skipped", reason: "script_absent" });
    // Static passes: lint runs via the configured bare tool, typecheck is N/A (JS), build skipped.
    expect(bundle.outcome).toBe("passed");
    expect(bundle.checks.some((c) => c.status === "blocked")).toBe(false);
  });

  it("a declared build script plus no lockfile stays blocked", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { build: "tsc -b" } }),
    });
    await mkdir(join(root, "node_modules"), { recursive: true });
    const provider = new ProjectVerificationProvider({ projectRoot: root });
    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: root,
      workspaceId: null,
    });

    expect(checkFor(bundle, "build")).toMatchObject({
      status: "blocked",
      reason: "package_manager_unknown",
    });
    expect(bundle.outcome).toBe("blocked");
  });

  it("a configured command is unaffected by an unknown package manager", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "fixture", private: true }),
      "agent-workflow.config.json": JSON.stringify({
        schemaVersion: 1,
        verification: {
          static: [{ id: "lint", capability: "lint", executable: "echo", args: ["hello"] }],
        },
      }),
    });
    const provider = new ProjectVerificationProvider({ projectRoot: root });
    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: root,
      workspaceId: null,
    });

    const lint = checkFor(bundle, "lint");
    expect(lint).toMatchObject({ status: "passed" });
    expect(bundle.outcome).toBe("passed");
  });

  it("existing blocked cases still block (declared lint script, no lockfile, no configured cover)", async () => {
    const root = await makeProject({
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { lint: "eslint ." } }),
    });
    await mkdir(join(root, "node_modules"), { recursive: true });
    const provider = new ProjectVerificationProvider({ projectRoot: root });
    const bundle = await provider.collect({
      featureId: "F-001",
      stage: "static_verification",
      verification: "static",
      revision: 1,
      projectRoot: root,
      workspaceId: null,
    });

    expect(checkFor(bundle, "lint")).toMatchObject({
      status: "blocked",
      reason: "package_manager_unknown",
    });
    expect(bundle.outcome).toBe("blocked");
  });
});
