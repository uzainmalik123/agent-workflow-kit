import {
  DEFAULT_OPENCODE_COMMAND,
  describeCapabilities,
  missingRunCapabilities,
  probeOpenCodeCapabilities,
  type OpenCodeCapabilities,
} from "@agent-workflow-kit/opencode";

export interface PreflightOpenCodeOptions {
  /**
   * The executable to probe. Defaults to {@link DEFAULT_OPENCODE_COMMAND}, which is the `opencode`
   * the transport spawns: the executable a stage run uses and the executable the preflight checks
   * are the same name resolved from the same `PATH`, so one of them cannot pass while the other
   * fails. It is a parameter for a test that needs a name no `PATH` contains, not a configuration
   * surface.
   */
  readonly command?: string;
}

/**
 * The capability probe from PRD §10.4, run before the first stage of a CLI `run` so an unusable
 * OpenCode fails the command with an answer instead of failing a stage inside the workflow.
 *
 * It runs only the probe's local, provider-free commands — `opencode --version` and a handful of
 * `--help` reads — so nothing here contacts a model, and every one of them is bounded by the probe's
 * own timeout, so a missing, broken, or wedged binary ends in a refusal rather than a hang. The
 * version that was read is carried back so the caller can record it in its debug output.
 */
export async function preflightOpenCode(
  options: PreflightOpenCodeOptions = {},
): Promise<OpenCodeCapabilities> {
  const command = options.command ?? DEFAULT_OPENCODE_COMMAND;
  const capabilities = await probeOpenCodeCapabilities({ command });

  if (!capabilities.executableFound) {
    throw new Error(
      `${describeCapabilities(capabilities)} \`agentflow run\` needs that command on PATH before any stage can run.`,
    );
  }

  if (capabilities.versionSupportsV2 === false) {
    throw new Error(
      `The OpenCode at "${command}" reports ${capabilities.version ?? "an unreadable version"}, which predates the V2 CLI this kit drives. ${describeCapabilities(capabilities)}`,
    );
  }

  const missing = missingRunCapabilities(capabilities);

  if (missing.length > 0) {
    throw new Error(
      `The OpenCode at "${command}" (${capabilities.version ?? "version unknown"}) does not advertise the run flags this kit needs: ${missing.join(", ")}.`,
    );
  }

  return capabilities;
}

/** The one line `run --verbose` prints so the probed version is on the record. */
export function describeVersionProbe(capabilities: OpenCodeCapabilities): string {
  return `opencode --version: ${capabilities.version ?? "unreadable"}`;
}
