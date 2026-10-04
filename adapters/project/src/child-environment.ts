/**
 * The environment a repository-controlled command is given.
 *
 * A verification command is read out of the repository: a `package.json` script, an
 * `agent-workflow.config.json` entry, a runtime `command`. It is therefore code this framework has
 * never read, and it is executed by the operator, in the operator's session, as the operator. The
 * operator's environment is also where the credentials are — a registry token, a cloud key, an API
 * token, a signing key — and copying it into every one of those commands would hand all of it to
 * every repository the kit is pointed at. The agent never has to read the secret for the repository
 * to take it: printing it once, inside a script that fails for an unrelated reason, turns an ordinary
 * verification evidence record into the exfiltration itself.
 *
 * So the default environment is *built*, not copied. It is an allowlist of the few host variables a
 * verification command genuinely cannot run without, plus whatever the framework itself supplies. A
 * variable that is not on the list is not inherited, which means a credential cannot be delivered by
 * accident, by a name nobody thought of, or by a shell that happens to have exported it.
 *
 * Two properties are worth stating plainly, because the boundary is only worth what it actually does.
 *
 * This is a delivery boundary, not a sandbox. It stops the operator's environment being handed to code
 * the repository chose. It does not stop a child process from reading a file its own user can read, so
 * it is one control among the ones that already exist — `shell: false`, array argv, refused lifecycle
 * scripts, refused install subcommands — rather than the one that makes the others unnecessary.
 *
 * And nothing in repository configuration can widen it. `agent-workflow.config.json` accepts
 * `id`, `capability`, `executable`, `args`, and `cwd` for a command and refuses every other field, and
 * the runtime command accepts `executable`, `args`, and `cwd`; there is no `env` key to set and no
 * place for one to be written. The only caller that can widen this is framework wiring, which is where
 * the decision about what a child process is allowed to know belongs.
 */

/**
 * The host variables a repository-controlled command may have.
 *
 * Every entry is here because a command in this repository's verification flow either cannot run
 * without it, or cannot mean the same thing without it:
 *
 * - `PATH` is how an executable is found at all. `pnpm`, `npm`, `node`, `tsc`, and `eslint` are all
 *   named without a path, so a run without it reports `executable_not_found` for every detected
 *   command rather than the project's real result;
 * - `PATHEXT`, `SystemRoot`, `SystemDrive`, and `WINDIR` are Windows' half of the same thing:
 *   extension resolution so `pnpm.cmd` is found as well as `pnpm`, and the system directories Windows
 *   resolves a relative path against. Windows reads environment names case-insensitively, so spelling
 *   them the way they are conventionally written is enough;
 * - `LANG` and `LC_ALL` decide collation, character classification, and the encoding of a message, so
 *   dropping them would change what a tool *prints* rather than keep a run reproducible. Forwarded
 *   when the host has them and simply absent when it does not;
 * - `TMPDIR`, `TEMP`, and `TMP` are where a tool puts a scratch file. `os.tmpdir()` falls back to
 *   `/tmp` without them, so nothing here depends on forwarding them; they are carried so a child writes
 *   its temporary files where the operator's own tools would.
 *
 * The omissions are as deliberate as the inclusions, and the interesting one is `HOME`. It is not
 * needed: `node`, `pnpm`, and `npm` each resolve a home directory through the platform rather than
 * through the variable, so a verification run does not depend on receiving it — and it is the shortest
 * path from a child process to `.netrc`, `.npmrc`, `.aws/credentials`, and `.ssh`. The `XDG_*` family
 * is left out for the same reason in the opposite direction: it names the operator's own configuration
 * and cache directories, which is exactly where this framework writes its own generated configuration,
 * and a repository-controlled command has no business being told about it.
 */
export const SAFE_HOST_ENVIRONMENT_VARIABLES: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
];

/**
 * Builds the environment a repository-controlled command runs with.
 *
 * The result is the allowlisted host variables that are actually set, with `overrides` merged over
 * them. The overrides are framework-supplied: the OpenCode transport passes the directory it generated
 * a configuration into, and the workspace publisher passes the alternate index file it needs. They are
 * applied last, so the framework can state a value rather than accept one, and they are the only way
 * anything beyond the allowlist arrives — which is what keeps a caller's `env` a statement about the
 * run rather than a request for the host's secrets.
 *
 * A variable the host does not have is omitted rather than forwarded as an empty string. An empty
 * `PATH` is a search path that finds nothing, where an absent one is the honest description of a host
 * that has nothing to say, and the distinction matters to a caller reading this value.
 */
export function buildChildEnvironment(
  overrides?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: Record<string, string> = {};

  for (const name of SAFE_HOST_ENVIRONMENT_VARIABLES) {
    const value = process.env[name];

    if (typeof value === "string" && value.length > 0) {
      environment[name] = value;
    }
  }

  return overrides === undefined ? environment : { ...environment, ...overrides };
}