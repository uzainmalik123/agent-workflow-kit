import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildChildEnvironment,
  loadProjectVerificationConfig,
  PROJECT_CONFIG_FILENAME,
  ProjectVerificationProvider,
  runChildProcess,
  SAFE_HOST_ENVIRONMENT_VARIABLES,
  startChildProcess,
  type ChildProcessRequest,
} from "@agent-workflow-kit/project";
import { afterEach, describe, expect, it } from "vitest";

/**
 * What a repository-controlled command can see of the operator's environment.
 *
 * A verification command is read out of the repository and run as the operator, so the environment it
 * inherits is the difference between a lint run and a credential handed to whoever wrote the
 * `package.json`. Every test here states one face of that boundary: a credential in the parent
 * environment does not appear in the child, an executable named without a path is still found, an
 * explicit value the framework supplies does arrive, a variable the host does not have is simply
 * absent, and the child is never handed the operator's environment wholesale.
 *
 * The credential is fabricated and named, so a failure says which direction leaked rather than
 * disclosing something real, and the assertions are made on both the captured text and the parsed
 * environment, because a secret reaching the evidence is the actual harm even if no test reads it.
 */

/** Credential-shaped, deliberately fake, and absent from the host unless a test puts it there. */
const FAKE_CREDENTIAL_NAME = "AGENT_WORKFLOW_KIT_FAKE_CREDENTIAL";
const FAKE_CREDENTIAL = "not-a-real-secret-3f9c1ad2";

/** Optional variables the allowlist forwards when the host has them, and omits when it does not. */
const OPTIONAL_SAFE_VARIABLES = ["LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"] as const;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeProject(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-kit-env-"));
  roots.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }

  return root;
}

/** Puts the fake credential in the operator's environment for the length of one run. */
async function withFakeCredential<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env[FAKE_CREDENTIAL_NAME];
  process.env[FAKE_CREDENTIAL_NAME] = FAKE_CREDENTIAL;

  try {
    return await body();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, FAKE_CREDENTIAL_NAME);
    } else {
      process.env[FAKE_CREDENTIAL_NAME] = previous;
    }
  }
}

/** Removes a set of variables for the length of one run, and puts them back afterwards. */
async function withoutVariables<T>(names: readonly string[], body: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const name of names) {
    previous.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }

  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** A child that reports its entire environment, which is what makes a leak visible at all. */
const REPORTS_ITS_ENVIRONMENT = "process.stdout.write(JSON.stringify(process.env));\n";

/**
 * A child that reports one named variable and nothing else.
 *
 * Used where the environment is too large to dump: the capture keeps a bounded head and tail, so the
 * host's own environment — which is what `inheritEnv: true` hands over — cannot be read back out of the
 * evidence, and a test that parsed it would be measuring the capture window instead of the boundary.
 */
const REPORTS_ONE_VARIABLE = 'process.stdout.write(`${process.argv[2]}=${process.env[process.argv[2]] ?? "absent"}`);\n';

function seenEnvironment(stdout: string): Record<string, string> {
  return JSON.parse(stdout) as Record<string, string>;
}

/** An executable plus an argument array, for a command run by absolute path so PATH is not involved. */
async function makeProbeCommand(root: string, name = "probe.mjs", body = REPORTS_ITS_ENVIRONMENT): Promise<string> {
  const path = join(root, name);
  await writeFile(path, body, "utf8");
  return path;
}

const run = (root: string, overrides: Partial<ChildProcessRequest> & { readonly executable: string }) =>
  runChildProcess({ args: [], timeoutMs: 10_000, cwd: root, ...overrides });

describe("what a repository-controlled command is given", () => {
  it("does not hand an operator credential to a verification command", async () => {
    // The whole path a repository chooses: a `package.json` script, dispatched by the package manager
    // the framework detected, recorded as evidence. The script prints the one variable it came for,
    // because a hostile script would print exactly that and let the evidence carry it out.
    const root = await makeProject({
      "probe.mjs": REPORTS_ONE_VARIABLE,
      "node_modules/.bin/runner": `#!/bin/sh\nexec node probe.mjs ${FAKE_CREDENTIAL_NAME}\n`,
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { lint: "runner" } }),
      // A lockfile pnpm would not want to repair: repairing one writes to a fingerprinted file, and a
      // stage whose command changed the tree is refused whatever it exited with.
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
    });
    await chmod(join(root, "node_modules/.bin/runner"), 0o755);

    const bundle = await withFakeCredential(
      async () =>
        await new ProjectVerificationProvider({ projectRoot: root }).collect({
          featureId: "F-001",
          stage: "static_verification",
          verification: "static",
          revision: 1,
          projectRoot: root,
          workspaceId: null,
        }),
    );

    const check = bundle.checks.find((entry) => entry.id === "lint");

    // The command really ran and really passed, which is what makes the absence below mean something:
    // the script was not skipped, blocked, or stopped before it produced a line of output.
    expect(check).toMatchObject({ status: "passed", exitCode: 0 });
    expect(bundle.outcome).toBe("passed");
    expect(check?.stdoutExcerpt).toContain(`${FAKE_CREDENTIAL_NAME}=absent`);
    expect(check?.stdoutExcerpt).not.toContain(FAKE_CREDENTIAL);
  });

  it("does not hand an operator credential to a runtime command", async () => {
    // The supervised runner is the other way into `spawn`, and a runtime verification starts a process
    // meant to stay up. It is exercised here directly so the two entry points cannot drift apart: the
    // policy lives in the one launch, and this is the half that would regress if it were duplicated.
    const root = await makeProject();
    const probe = await makeProbeCommand(root);

    await withFakeCredential(async () => {
      const child = startChildProcess({
        executable: process.execPath,
        args: [probe],
        cwd: root,
        signal: null,
      });

      const outcome = await child.finished;

      expect(outcome.termination).toBe("exited");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout.text).not.toContain(FAKE_CREDENTIAL);
      expect(seenEnvironment(outcome.stdout.text)).not.toHaveProperty(FAKE_CREDENTIAL_NAME);
    });
  });

  it("still finds an executable that is named without a path", async () => {
    // The forwarded `PATH` is the one variable the allowlist cannot do without, so this is the test
    // that says the safe environment did not quietly break every detected command: `node` is spelled
    // with no directory, and the run resolves it through the forwarded `PATH` alone.
    const root = await makeProject();

    const outcome = await run(root, {
      executable: "node",
      args: ["-e", 'process.stdout.write(JSON.stringify({ version: process.version, path: process.env.PATH ?? null }));'],
    });

    expect(outcome.termination).toBe("exited");
    expect(outcome.exitCode).toBe(0);

    const reported = seenEnvironment(outcome.stdout.text);

    expect(typeof reported["version"]).toBe("string");
    expect(reported["path"]).toBe(process.env["PATH"]);
  });

  it("delivers an explicit value the framework supplied", async () => {
    const root = await makeProject();
    const probe = await makeProbeCommand(root);

    const outcome = await run(root, {
      executable: process.execPath,
      args: [probe],
      env: { AGENT_WORKFLOW_KIT_PROBE: "supplied", LC_ALL: "C" },
    });

    const seen = seenEnvironment(outcome.stdout.text);

    // An added entry arrives, and it arrives over the allowlist rather than beside it: the runner
    // supplies a value for this run rather than asking the host what it thinks.
    expect(seen["AGENT_WORKFLOW_KIT_PROBE"]).toBe("supplied");
    expect(seen["LC_ALL"]).toBe("C");
    expect(seen["PATH"]).toBe(process.env["PATH"]);
  });

  it("omits an allowlisted variable the host does not have", async () => {
    const root = await makeProject();
    const probe = await makeProbeCommand(root);

    await withoutVariables(OPTIONAL_SAFE_VARIABLES, async () => {
      const outcome = await run(root, { executable: process.execPath, args: [probe] });

      // Nothing here is required, so nothing being there is not a failure: the run is expected to
      // succeed with the optional half of the allowlist entirely absent.
      expect(outcome.termination).toBe("exited");
      expect(outcome.exitCode).toBe(0);

      const seen = seenEnvironment(outcome.stdout.text);

      for (const name of OPTIONAL_SAFE_VARIABLES) {
        expect(seen).not.toHaveProperty(name);
      }

      expect(seen["PATH"]).toBe(process.env["PATH"]);
    });
  });

  it("does not pass the operator's environment through wholesale", async () => {
    const root = await makeProject();
    const probe = await makeProbeCommand(root);

    const outcome = await withFakeCredential(
      async () => await run(root, { executable: process.execPath, args: [probe] }),
    );

    const names = Object.keys(seenEnvironment(outcome.stdout.text)).sort();

    // Everything the child has is on the allowlist, which is the shape of the claim rather than an
    // example of it: a name nobody thought of would fail here, and so would a credential.
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !SAFE_HOST_ENVIRONMENT_VARIABLES.includes(name))).toEqual([]);
    expect(names).not.toContain(FAKE_CREDENTIAL_NAME);
    // `HOME` is the omission worth stating, because it is the one an operator would expect to be
    // there and the one that points at `.netrc`, `.npmrc`, `.aws/credentials`, and `.ssh`.
    expect(names).not.toContain("HOME");
    expect(names).not.toEqual([...Object.keys(process.env)].sort());
  });

  it("hands over the host environment only when a caller asks for it by name", async () => {
    // The mirror of the claim above, so the opt-in cannot rot: framework wiring that runs the
    // operator's own tooling — the OpenCode transport's stage runs, which need a model credential —
    // still receives the host environment, and receives it by asking rather than by omitting.
    const root = await makeProject();
    const probe = await makeProbeCommand(root, "probe.mjs", REPORTS_ONE_VARIABLE);

    const outcome = await withFakeCredential(
      async () =>
        await run(root, {
          executable: process.execPath,
          args: [probe, FAKE_CREDENTIAL_NAME],
          inheritEnv: true,
        }),
    );

    expect(outcome.stdout.text).toBe(`${FAKE_CREDENTIAL_NAME}=${FAKE_CREDENTIAL}`);
  });
});

describe("what a repository can ask for", () => {
  it("refuses a configured command that names environment variables", async () => {
    const root = await makeProject({
      [PROJECT_CONFIG_FILENAME]: JSON.stringify({
        schemaVersion: 1,
        verification: {
          static: [
            {
              id: "lint",
              capability: "lint",
              executable: "eslint",
              args: ["."],
              env: { GITHUB_TOKEN: "stolen" },
            },
          ],
        },
      }),
    });

    const refusal = await loadProjectVerificationConfig(root).catch((error: unknown) => error as Error);

    // There is no field to set, so there is nothing to sanitize and no name to filter: the request is
    // refused before a command exists.
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as { code?: string }).code).toBe("config_invalid");
    expect((refusal as Error).message).toContain('unknown field "env"');
  });

  it("refuses a runtime command that names environment variables", async () => {
    const root = await makeProject({
      [PROJECT_CONFIG_FILENAME]: JSON.stringify({
        schemaVersion: 1,
        verification: {
          runtime: {
            command: { executable: "node", args: ["server.mjs"], env: { AWS_SECRET_ACCESS_KEY: "stolen" } },
            checks: [{ id: "up", kind: "process_start", stableMs: 100 }],
          },
        },
      }),
    });

    const refusal = await loadProjectVerificationConfig(root).catch((error: unknown) => error as Error);

    expect((refusal as { code?: string }).code).toBe("config_invalid");
    expect((refusal as Error).message).toContain('unknown field "env"');
  });

  it("sends no environment of its own when running a repository-declared command", async () => {
    // The provider is where a request becomes a `ChildProcessRequest`, so this is where the boundary
    // would be reopened if anything could get in. Nothing does: the request carries neither `env` nor
    // `inheritEnv`, and the allowlist comes from the runner alone.
    const root = await makeProject();
    await makeProbeCommand(root, "probe.mjs", REPORTS_ONE_VARIABLE);
    const executable = join(root, "lint.sh");
    await writeFile(executable, `#!/bin/sh\nexec ${process.execPath} probe.mjs ${FAKE_CREDENTIAL_NAME}\n`, "utf8");
    await chmod(executable, 0o755);
    await writeFile(
      join(root, PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        verification: { static: [{ id: "lint", capability: "lint", executable, args: [] }] },
      }),
      "utf8",
    );

    const requests: ChildProcessRequest[] = [];
    const bundle = await withFakeCredential(
      async () =>
        await new ProjectVerificationProvider({
          projectRoot: root,
          run: (request) => {
            requests.push(request);
            return runChildProcess(request);
          },
        }).collect({
          featureId: "F-001",
          stage: "static_verification",
          verification: "static",
          revision: 1,
          projectRoot: root,
          workspaceId: null,
        }),
    );

    expect(bundle.outcome).toBe("passed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.env).toBeUndefined();
    expect(requests[0]?.inheritEnv).toBeUndefined();
    expect(bundle.checks[0]?.stdoutExcerpt).toBe(`${FAKE_CREDENTIAL_NAME}=absent`);
  });
});

describe("the allowlist itself", () => {
  it("names no variable that could be a credential", () => {
    // A blacklist cannot answer "what did we not think of", so the list is the policy and this is the
    // check on the policy rather than on one run: adding a token, key, or credential-shaped name to an
    // allowlist is a mistake this fails instead of shipping.
    expect(
      SAFE_HOST_ENVIRONMENT_VARIABLES.filter((name) =>
        /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|NPM_|YARN_|AWS_|GITHUB_|GH_|AZURE_|GOOGLE_/u.test(
          name,
        ),
      ),
    ).toEqual([]);
  });

  it("builds an environment from what the host actually has", () => {
    const environment = buildChildEnvironment();

    expect(Object.keys(environment).sort()).toEqual(
      SAFE_HOST_ENVIRONMENT_VARIABLES.filter((name) => {
        const value = process.env[name];
        return typeof value === "string" && value.length > 0;
      }).sort(),
    );
    // Omitted rather than empty: an empty `PATH` is a search path that finds nothing, where an absent
    // one is the honest description of a host that has nothing to say.
    expect(Object.values(environment).some((value) => value === "")).toBe(false);
    expect(buildChildEnvironment({ EXTRA: "1" })).toMatchObject({ EXTRA: "1", PATH: process.env["PATH"] });
  });
});