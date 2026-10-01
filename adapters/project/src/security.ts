import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  deriveSecurityStatus,
  SECURITY_CHECK_LABELS,
  type SecurityCheckEvidence,
  type SecurityCheckId,
  type SecurityReviewEvidence,
  type SecurityReviewProvider,
  type SecurityReviewRequest,
} from "@agent-workflow-kit/orchestration";
import { ProjectAdapterError } from "./errors.js";
import { joinWithin } from "./fs-safe.js";

/**
 * The deterministic content checks.
 *
 * These are the checks a port implementation has to make, because they need to open a file. The
 * framework's own two change-shaped checks live in the orchestration layer and are merged in
 * afterwards, so nothing here has to know about them — which is the reason this file can be wrong
 * about the framework's policy without weakening it.
 *
 * Every rule below is a pattern over text and a file mode, and that is stated plainly because the
 * limit is real: this is a scan for the shapes a careless or compromised change has, not an analysis
 * of what the change means. Three consequences are worth knowing before trusting a `pass`:
 *
 * - For a file the plan described as a modification, the checks read the file's *current* contents.
 *   A pattern that was already in the file before this feature is reported as if the feature added
 *   it. The error runs in the direction that refuses rather than passes, and the honest way to get the
 *   narrower answer is a content diff, which this port does not ask for. Where a finding lands on a
 *   modified file, the recorded reason says so.
 * - A secret the writer obfuscated past a pattern is not found. Nothing here attempts to catch that,
 *   and a scanner that claimed to would be claiming a guarantee no pattern list has.
 * - A `passed` check means that check ran and found nothing in the files it read. It is not a claim
 *   about any other check, and it is not a claim that the change is safe.
 *
 * Every path a check reports is project-relative and forward-slashed, so it is usable as a fix target
 * and comparable against the approved scope without further conversion.
 */

/**
 * The ceiling on one file's contents.
 *
 * The same number the manifest reader refuses above, rather than a value of its own, because the two
 * answers should not differ: a file this adapter is willing to read for discovery is the same file it
 * is willing to scan. A file above it is reported as `inconclusive` naming the path, never skipped
 * silently — an unread file that is not reported is an unread file that was decided to be fine.
 */
const SCAN_CEILING = 2_000_000;

/* -------------------------------------------------------------------------------------------- */
/* Path classification                                                                             */
/* -------------------------------------------------------------------------------------------- */

const CREDENTIAL_FILE_NAME =
  /^(?:\.env(?:\..*)?|\.netrc|\.pypirc|\.npmrc|\.htpasswd|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|ovpn|kdbx))$/iu;

/**
 * A path whose name marks its contents as a sample rather than a live credential.
 *
 * A checked-in `.env.example` is the normal way to document a variable and is not a finding. A
 * checked-in `.env` is the other thing entirely, and the difference is entirely in the name, so this
 * is the one place a name is allowed to decide on its own.
 */
const SAMPLE_PATH =
  /(?:\.example|\.sample|\.template|\.dist|\.tpl|\.stub)$|(?:^|\/)(?:example|sample|template|dist|fixtures?)\//iu;

const SCRIPT_SUFFIXES: ReadonlySet<string> = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".ksh",
  ".fish",
  ".csh",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".com",
  ".vbs",
  ".wsf",
  ".run",
]);

const MANIFEST_PATH =
  /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|pyproject\.toml|requirements(?:-[^/]*)?\.txt|Pipfile|setup\.py|setup\.cfg|[^/]+\.gemspec|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|go\.mod|Cargo\.toml|composer\.json)$/u;

const REQUIREMENTS_PATH = /(^|\/)requirements(?:-[^/]*)?\.txt$/u;

const WORKFLOW_PATH = /(^|\/)\.github\/workflows\//u;

/* -------------------------------------------------------------------------------------------- */
/* Secret shapes                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Credentials whose format is fixed by whoever issues them.
 *
 * Matched by shape rather than by name because a name is the thing a writer controls and these
 * prefixes are not: a variable named `apiKey` holding a value beginning `ghp_` is a leaked token
 * whatever the surrounding line is called. The shapes are specific enough that a false positive is
 * not a realistic concern, and the two error directions are not symmetric — a false positive costs a
 * fixer one edit, a miss costs a credential in every clone of the repository.
 */
const ISSUER_TOKEN_SHAPES: readonly { readonly label: string; readonly source: string; readonly flags: string }[] =
  [
    { label: "a GitHub personal access token", source: "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b", flags: "gu" },
    { label: "a GitHub fine-grained token", source: "\\bgithub_pat_[A-Za-z0-9_]{30,}\\b", flags: "gu" },
    { label: "an OpenAI API key", source: "\\bsk-[A-Za-z0-9]{32,}\\b", flags: "gu" },
    { label: "an AWS access key id", source: "\\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\\b", flags: "gu" },
    { label: "a Slack token", source: "\\bxox[abposr]-[A-Za-z0-9-]{20,}\\b", flags: "gu" },
    { label: "a GitLab personal access token", source: "\\bglpat-[A-Za-z0-9_-]{20,}\\b", flags: "gu" },
    { label: "a Google API key", source: "\\bAIza[0-9A-Za-z_-]{35}\\b", flags: "gu" },
    {
      label: "a JSON Web Token",
      source: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}\\b",
      flags: "gu",
    },
    { label: "an npm token", source: "\\bnpm_[A-Za-z0-9]{30,}\\b", flags: "gu" },
    { label: "a Stripe live secret key", source: "\\bsk_live_[A-Za-z0-9]{20,}\\b", flags: "gu" },
  ];

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/u;

/**
 * An assignment whose *name* says it holds a credential.
 *
 * A name match alone is far too noisy to be a finding — `password_reset_url` and `token_budget` are
 * not secrets — so a name match is only ever half of the answer. The value has to be a string literal
 * as well, and the literal has to survive `isPlaceholderValue`. Both halves being a writer's mistake
 * is what makes this a check rather than a lint.
 */
const NAMED_CREDENTIAL_ASSIGNMENT =
  /(?:^|[^\w$])(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|passwd|password|passphrase|credential|credentials)\b\s*(?:[:=]|=>)\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/giu;

/**
 * Values that are obviously not credentials.
 *
 * This list is the difference between a check people run and a check people turn off. A secret scan
 * that reports `password = "changeme"` in every fixture in a repository is a check whose output carries
 * no information, and the right response to that is to stop running it. Every entry here is a value
 * that cannot function as a credential — an indirection into the environment, a template that has not
 * been filled in, a call, or one of the words a project writes when it means "this is a placeholder" —
 * and every one is about the *value*, never about the variable name, because a placeholder is a
 * property of what is written down rather than of what it is called.
 */
const PLACEHOLDER_VALUE =
  /^(?:|x+|X+|\*+|\.+|-+|_+|0+|1+|n\/a|na|none|null|nil|undefined|true|false|changeme|change-me|change_me|replaceme|placeholder|example|sample|dummy|fake|mock|test|testing|secret|password|token|apikey|api-key|api_key|abc123|123456|1234567890|0123456789|qwerty|asdfghjkl|abcdefghijklmnop|lorem ipsum)$/iu;

const PLACEHOLDER_FRAGMENT =
  /(?:^|[^a-z])(?:example|placeholder|changeme|change-me|replace[-_ ]?me|your[-_ ]|my[-_ ]|redacted|dummy|sample|lorem ipsum|not[-_ ]?(?:a[-_ ])?real|insert[-_ ]|todo|fixme|xxxxx|yourkey|yourtoken|fake)(?:[^a-z]|$)/iu;

const ENVIRONMENT_REFERENCE =
  /(?:\$\{|\$[A-Za-z_]\w*|\{\{|<%|%\(|\bprocess\.env\b|\bDeno\.env\b|\bimport\.meta\.env\b|\bos\.environ\b|\bos\.getenv\b|\bENV\[|\bSystem\.getenv\b|\bENVIRON\[|\bgetenv\(|\bstd::env\b|\benv::var\b|\bENV\.[A-Za-z_])/u;

/* -------------------------------------------------------------------------------------------- */
/* Shell execution                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Constructs that hand a string to a command interpreter.
 *
 * The rule is about the *construction*, not the payload. A project may legitimately run a command it
 * built itself, and the question this check answers is whether the change introduced a way to run a
 * string as a program, which is the mechanism a command-injection defect needs. `spawn` and
 * `execFile` without a shell are not in the list because an argument array is not a string a shell
 * reads; `spawn` with `shell: true` is, and it is matched separately below.
 */
const SHELL_EXECUTION_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "child_process.exec", pattern: /\b(?:child_process\.)?exec(?:Sync)?\s*\(/u },
  { label: "a child_process spawn", pattern: /\bspawnSync?\s*\(/u },
  { label: "os.system or os.popen", pattern: /\bos\.system\s*\(|\bos\.popen\s*\(/u },
  { label: "shell=True in a subprocess call", pattern: /\bshell\s*=\s*True\b/u },
  { label: "subprocess without an argument list", pattern: /\bsubprocess\.(?:run|call|Popen|check_call|check_output)\s*\(\s*["']/u },
  { label: "an explicit shell in a Go exec", pattern: /\bexec\.Command(?:Context)?\s*\(\s*"(?:sh|bash|zsh|cmd(?:\.exe)?|powershell)"/u },
  { label: "eval of a string", pattern: /\beval\s*\(\s*(?:"|'|`)/u },
  { label: "new Function from a string", pattern: /\bnew\s+Function\s*\(\s*(?:"|'|`)/u },
  { label: "an interpolated backtick string in a JavaScript or TypeScript file", pattern: /`[^`\n]*\$\{[^}\n]*\}[^`\n]*`/u },
  { label: "Ruby string interpolation inside backticks", pattern: /`[^`\n]*#\{[^}\n]*\}[^`\n]*`/u },
  { label: "a shell pipe or xargs in a command", pattern: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|\bxargs\b/u },
  { label: "curl or wget piped into an interpreter", pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node)\b/u },
  {
    label: "a hidden or encoded PowerShell invocation",
    pattern: /\b(?:powershell|pwsh)\b[^\n]*-(?:enc|encodedcommand|w|windowstyle\s+hidden)\b/iu,
  },
];

/* -------------------------------------------------------------------------------------------- */
/* Restriction weakening                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * Files whose job is to deny something.
 *
 * The rule that fires on all of them is the same, which is why one pattern serves the whole set: a
 * line beginning `!` in an ignore file re-includes what the file exists to exclude, and there is no
 * reading of `!.env` in a `.gitignore` that is not a widened boundary.
 */
const RESTRICTION_SURFACE =
  /(^|\/)(?:\.gitignore|\.eslintignore|\.prettierignore|\.dockerignore|\.npmignore|\.gcloudignore|\.helmignore)$/u;

const NEGATION_DIRECTIVE = /^[ \t]*!+\s*(\S+)[ \t]*$/u;

/** The kinds of thing the ignore files above are conventionally written to exclude. */
const NEGATED_SENSITIVE_SHAPE =
  /(?:\.env\b|\.env\..*|\.npmrc|\.netrc|\.pypirc|\.htpasswd|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg)|.*credentials.*|secrets?\..*)/iu;

/** Bypassing a hook that exists to refuse something. */
const HOOK_BYPASS_SHAPE =
  /\bgit\b[^\n]*--no-verify|\b--no-verify\b[^\n]*\b(?:commit|push|amend|merge|tag)\b/u;

/* -------------------------------------------------------------------------------------------- */
/* Executables and permissions                                                                     */
/* -------------------------------------------------------------------------------------------- */

const SHEBANG = /^#![^\n]*(?:\/bin\/|\/usr\/bin\/env\b)/u;

/* -------------------------------------------------------------------------------------------- */
/* Package-manager hooks                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * Script names a package manager runs on its own, without the project asking for them.
 *
 * `install`, `preinstall`, `postinstall`, `prepare`, and `prepublish` are run by the manager during an
 * install or a pack. A change that adds one of these is a change to what happens on every other
 * developer's machine when they type `npm install`, which is a materially different thing from a
 * change to the code that runs when the application starts — and it is the mechanism every published
 * supply-chain compromise has used.
 */
const LIFECYCLE_SCRIPTS: ReadonlySet<string> = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishonly",
  "postpublish",
  "prepack",
  "postpack",
  "prepublishpack",
  "postpublishpack",
]);

/**
 * A lifecycle script body that reaches outside the project.
 *
 * A `postinstall` that runs `tsc -b` is an ordinary build step. A `postinstall` that fetches and runs
 * something is not, and the difference is visible in the body: a network client, a pipe into an
 * interpreter, a remote URL, or a decoded payload is a script that behaves differently on a machine
 * with different network access than on the one that wrote it. A hook that only builds the project is
 * not reported, because there is no shape of `postinstall` that is safe in general and reporting all
 * of them would make this check noise.
 */
const HOOK_PAYLOAD_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "a network client", pattern: /\b(?:curl|wget|fetch|Invoke-WebRequest|iwr)\b/iu },
  { label: "a pipe into an interpreter", pattern: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|ruby|perl)\b/u },
  { label: "a remote URL", pattern: /https?:\/\/\S+/u },
  { label: "an inline script body", pattern: /\b(?:node|python3?|ruby|perl)\s+-(?:e|c)\b/iu },
  { label: "a decoded payload", pattern: /\bbase64\s+-{1,2}d(?:ecode)?\b|\bfromCharCode\b/iu },
  { label: "a permission change", pattern: /\bchmod\s+\+x\b|\bchmod\s+777\b/u },
  { label: "an eval", pattern: /\beval\s*\(|\bnew\s+Function\s*\(/u },
];

/** Dependency specifications that are not a registry version. */
const REMOTE_DEPENDENCY_SHAPES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "a git dependency", pattern: /(?:^|["'\s])(?:git\+|git:\/\/|github:|gitlab:|bitbucket:|ssh:\/\/)/u },
  { label: "a URL dependency", pattern: /(?:^|["'\s])https?:\/\/\S+/u },
  { label: "a local file dependency", pattern: /(?:^|["'\s])file:\/{0,2}\S+/u },
  { label: "a symlinked dependency", pattern: /(?:^|["'\s])link:\S+/u },
];

/* -------------------------------------------------------------------------------------------- */
/* Permission broadening                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** A workflow permission block that grants everything to everything. */
const CI_WRITE_ALL = /^[ \t]*permissions\s*:\s*(?:write-all|["']?write-all["']?)\s*$/mu;

/** A `permissions:` map whose every entry is a write. */
const CI_WRITE_ALL_MAP = /^[ \t]*permissions\s*:\s*\{[^}]*\bwrite-all\b[^}]*\}/mu;

/**
 * Triggers that run with the repository's own credentials rather than a contributor's.
 *
 * `pull_request_target` in particular runs the workflow from the base branch with a write token while
 * checking out the pull request's code, which is the shape every workflow-cryptomining compromise has
 * taken. The others are included because they share the property that matters: a person who did not
 * write to this repository can cause code in it to run with its permissions.
 */
const PRIVILEGED_TRIGGER =
  /^[ \t]*(?:pull_request_target|pull_request_review|issue_comment|workflow_dispatch|workflow_run)\b/mu;

/* -------------------------------------------------------------------------------------------- */
/* One changed file, as the checks see it                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * A file in the change set whose contents were read.
 *
 * `category` is the framework's classification, carried through so a `reason` can say whether what was
 * found was introduced by this change or may have been in the file already. `mode` is the raw
 * permission bits, which is what makes `permission_broadening` a measurement of the filesystem rather
 * than a guess from a filename.
 */
interface ScannedFile {
  readonly path: string;
  readonly category: "added" | "modified";
  readonly content: string;
  readonly mode: number;
}

interface UnreadableFile {
  readonly path: string;
  readonly reason: string;
}

interface ScanOutcome {
  readonly files: readonly ScannedFile[];
  readonly unreadable: readonly UnreadableFile[];
}

function categoryFor(path: string, request: SecurityReviewRequest): "added" | "modified" | null {
  if (request.changes.untracked.includes(path) || request.changes.added.includes(path)) {
    return "added";
  }

  if (request.changes.modified.includes(path)) {
    return "modified";
  }

  // A rename's destination is a path with new content in this tree even though Git calls the change a
  // rename, and its origin has nothing left to read. Treating the destination as added is what keeps
  // a rename from being invisible to every content check.
  if (request.changes.renamed.some((rename) => rename.to === path)) {
    return "added";
  }

  return null;
}

/**
 * Reads one changed file, or explains why it could not be read.
 *
 * A file that is simply absent returns null: that is a deletion, and a deletion has no contents. Every
 * other failure — a symlink, a directory, a file above the ceiling, a permission error — returns a
 * reason, because each of those is a file the review was told to look at and could not, and reporting
 * it as `inconclusive` is the difference between an unanswered question and a silently assumed answer.
 */
async function readChangedFile(
  root: string,
  path: string,
  request: SecurityReviewRequest,
): Promise<ScannedFile | UnreadableFile | null> {
  const category = categoryFor(path, request);

  if (category === null) {
    return null;
  }

  const absolute = joinWithin(root, path);
  let stats;

  try {
    stats = await lstat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return null;
    }

    return {
      path,
      reason: `It is in the change set but could not be inspected (${code ?? "an unidentified error"}).`,
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      path,
      reason:
        "It is in the change set and is a symbolic link, and a review does not follow links out of the project, so whatever it points at was not scanned.",
    };
  }

  if (!stats.isFile()) {
    return null;
  }

  if (stats.size > SCAN_CEILING) {
    return {
      path,
      reason: `It is ${String(stats.size)} bytes, above the ${String(SCAN_CEILING)} byte ceiling a review reads.`,
    };
  }

  try {
    return { path, category, content: await readFile(absolute, "utf8"), mode: stats.mode };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    return {
      path,
      reason: `It is in the change set but could not be read (${code ?? "an unidentified error"}).`,
    };
  }
}

async function scanChangeSet(root: string, request: SecurityReviewRequest): Promise<ScanOutcome> {
  const files: ScannedFile[] = [];
  const unreadable: UnreadableFile[] = [];

  for (const path of [...request.changedPaths].sort()) {
    const result = await readChangedFile(root, path, request);

    if (result === null) {
      continue;
    }

    if ("content" in result) {
      files.push(result);
    } else {
      unreadable.push(result);
    }
  }

  return { files, unreadable };
}

/* -------------------------------------------------------------------------------------------- */
/* Finding helpers                                                                                */
/* -------------------------------------------------------------------------------------------- */

interface Finding {
  readonly path: string;
  readonly detail: string;
}

function groupByPath(findings: readonly Finding[]): readonly {
  readonly path: string;
  readonly details: readonly string[];
}[] {
  const byPath = new Map<string, string[]>();

  for (const finding of findings) {
    const existing = byPath.get(finding.path);

    if (existing === undefined) {
      byPath.set(finding.path, [finding.detail]);
      continue;
    }

    if (!existing.includes(finding.detail)) {
      existing.push(finding.detail);
    }
  }

  return [...byPath.entries()]
    .map(([path, details]) => ({ path, details: [...details].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * The two outcomes every check here has, in one place.
 *
 * A check that found something is a `failed` whose reason names the paths and says what was in them; a
 * check that found nothing is a `passed` whose reason says what was looked for, so a reader of the
 * record can tell the difference between "this ran and this is its answer" and "this check is not
 * implemented here". An implementation that supported a subset of the vocabulary has to say so with
 * `inconclusive` rather than omitting the check, and the validator refuses a record that omits one.
 */
function report(input: {
  readonly check: SecurityCheckId;
  readonly findings: readonly Finding[];
  readonly passedReason: string;
  readonly failedFrame: string;
  readonly modifiedPaths?: readonly string[];
  readonly unreadable?: readonly UnreadableFile[];
}): SecurityCheckEvidence {
  if (input.unreadable !== undefined && input.unreadable.length > 0) {
    return {
      check: input.check,
      result: "inconclusive",
      paths: input.unreadable.map((entry) => entry.path),
      reason: [
        `${SECURITY_CHECK_LABELS[input.check]} could not be decided for the whole change set.`,
        ...input.unreadable.map((entry) => `${entry.path}: ${entry.reason}`),
        "A file the review was told to look at and could not is an unanswered question rather than a clean one, so this check is reported as undecided rather than passed.",
      ].join(" "),
      authority: "provider",
    };
  }

  if (input.findings.length === 0) {
    return {
      check: input.check,
      result: "passed",
      paths: [],
      reason: input.passedReason,
      authority: "provider",
    };
  }

  const grouped = groupByPath(input.findings);
  const modified = new Set(input.modifiedPaths ?? []);
  const touchedNotAdded = grouped
    .map((entry) => entry.path)
    .filter((path) => modified.has(path))
    .sort();

  return {
    check: input.check,
    result: "failed",
    paths: grouped.map((entry) => entry.path),
    reason: [
      input.failedFrame,
      ...grouped.map((entry) => `${entry.path}: ${entry.details.join(" ")}`),
      touchedNotAdded.length === 0
        ? "Every path above was added by this change, so what was found in it is what this change put there."
        : `These of the above were modified rather than added: ${touchedNotAdded.join(", ")}. The check read their current contents, so it cannot distinguish a line this change added from one that was already there, and a human may find the finding predates this feature.`,
    ].join(" "),
    authority: "provider",
  };
}

/** Whether the approved plan describes this path, which is the only authorization a write has. */
function isApproved(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    // The approved patterns use this framework's glob syntax, and a provider that cannot import the
    // matcher reimplements the two forms a plan actually produces: a literal path, and the `dir/**`
    // prefix that `normalizeScopePattern` writes for a directory pattern. Anything more exotic was
    // refused when the scope was derived, so there is nothing else to interpret.
    const prefix = pattern.endsWith("/**") ? pattern.slice(0, -2) : pattern;

    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

/* -------------------------------------------------------------------------------------------- */
/* The checks                                                                                     */
/* -------------------------------------------------------------------------------------------- */

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return true;
  }

  if (ENVIRONMENT_REFERENCE.test(trimmed)) {
    return true;
  }

  // A call is not a literal. `apiKey: readKeyFromVault()` is the correct way to write this.
  if (/^[A-Za-z_$][\w.$]*(?:\([^()]*\))?\s*(?:\?\?|\|\|)?\s*[A-Za-z_$]*(?:\([^()]*\))?$/u.test(trimmed)) {
    return true;
  }

  return PLACEHOLDER_VALUE.test(trimmed) || PLACEHOLDER_FRAGMENT.test(trimmed);
}

function secretFindings(files: readonly ScannedFile[]): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (SAMPLE_PATH.test(file.path)) {
      continue;
    }

    for (const shape of ISSUER_TOKEN_SHAPES) {
      // The shape is recompiled per file because a global `RegExp` keeps its `lastIndex` between
      // calls, and reusing the module-level object would make the second file in the change set match
      // from wherever the first one stopped.
      const matches = file.content.match(new RegExp(shape.source, shape.flags));

      if (matches !== null && matches.length > 0) {
        findings.push({ path: file.path, detail: `It contains ${shape.label}.` });
      }
    }

    if (PRIVATE_KEY_BLOCK.test(file.content)) {
      findings.push({ path: file.path, detail: "It contains a PEM private key block." });
    }

    for (const assignment of file.content.matchAll(NAMED_CREDENTIAL_ASSIGNMENT)) {
      const value = assignment[1] ?? assignment[2] ?? assignment[3] ?? "";

      if (isPlaceholderValue(value)) {
        continue;
      }

      const name = assignment[0].split(/(?:=>|[:=])/u)[0]?.trim() ?? "a credential";
      findings.push({
        path: file.path,
        detail: `It assigns a literal value to "${name}", which is not an environment reference, a template, or a placeholder.`,
      });
    }
  }

  return findings;
}

function credentialFileFindings(
  files: readonly ScannedFile[],
  request: SecurityReviewRequest,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (isApproved(file.path, request.approvedPatterns)) {
      continue;
    }

    const base = file.path.split("/").pop() ?? file.path;

    if (!CREDENTIAL_FILE_NAME.test(base)) {
      continue;
    }

    findings.push({
      path: file.path,
      detail: "Its name marks it as a credential store and the approved plan does not describe it.",
    });
  }

  return findings;
}

function executableFindings(
  files: readonly ScannedFile[],
  request: SecurityReviewRequest,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (isApproved(file.path, request.approvedPatterns)) {
      continue;
    }

    const executable = (file.mode & 0o111) !== 0;
    const suffix = extensionOf(file.path);
    const bySuffix = SCRIPT_SUFFIXES.has(suffix);
    const firstLine = file.content.split("\n", 1)[0] ?? "";
    const byShebang = SHEBANG.test(firstLine);

    if (!executable && !bySuffix && !byShebang) {
      continue;
    }

    findings.push({
      path: file.path,
      detail: `It is a script surface: ${
        [
          executable ? "the file has an execute bit set" : null,
          byShebang ? `it opens with the interpreter line "${firstLine.trim()}"` : null,
          bySuffix ? `it carries the script extension "${suffix}"` : null,
        ]
          .filter((entry): entry is string => entry !== null)
          .join(", ")
      }.`,
    });
  }

  return findings;
}

function shellExecutionFindings(files: readonly ScannedFile[]): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const labels: string[] = [];

    for (const shape of SHELL_EXECUTION_SHAPES) {
      if (shape.pattern.test(file.content)) {
        labels.push(shape.label);
      }
    }

    if (labels.length === 0) {
      continue;
    }

    findings.push({
      path: file.path,
      detail: `It contains ${[...new Set(labels)].sort().join(", ")}.`,
    });
  }

  return findings;
}

function restrictionFindings(
  files: readonly ScannedFile[],
  request: SecurityReviewRequest,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (isApproved(file.path, request.approvedPatterns)) {
      continue;
    }

    const labels = new Set<string>();

    if (RESTRICTION_SURFACE.test(file.path)) {
      for (const line of file.content.split("\n")) {
        const negation = NEGATION_DIRECTIVE.exec(line);

        if (negation === null) {
          continue;
        }

        const target = negation[1] ?? "";

        labels.add(
          NEGATED_SENSITIVE_SHAPE.test(target)
            ? `a negation rule that re-includes "${target}", which is a credential or a private key`
            : `a negation rule that re-includes "${target}"`,
        );
      }
    }

    if (HOOK_BYPASS_SHAPE.test(file.content)) {
      labels.add("a git invocation with --no-verify, which skips the hook that exists to refuse it");
    }

    for (const label of labels) {
      findings.push({ path: file.path, detail: `It contains ${label}.` });
    }
  }

  return findings;
}

function packageHookFindings(
  files: readonly ScannedFile[],
  request: SecurityReviewRequest,
): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (!MANIFEST_PATH.test(file.path)) {
      continue;
    }

    // A manifest the approved plan describes is still checked for hooks. A plan that says "add a
    // dependency" is a statement about what the code needs, not authorization for what the package
    // manager will run the next time it is installed, and the two are different questions. The
    // approved plan is therefore consulted for whether the *file* was expected here, and not for
    // whether its contents are acceptable.
    if (REQUIREMENTS_PATH.test(file.path) && isApproved(file.path, request.approvedPatterns)) {
      continue;
    }

    if (file.path.endsWith("package.json")) {
      findings.push(...nodeManifestFindings(file));
      continue;
    }

    if (REQUIREMENTS_PATH.test(file.path)) {
      findings.push(...requirementsFindings(file));
    }
  }

  return findings;
}

function nodeManifestFindings(file: ScannedFile): readonly Finding[] {
  const manifest = parseJsonObject(file.content);

  if (manifest === null) {
    return [];
  }

  const findings: Finding[] = [];

  const scripts = manifest["scripts"];

  if (isRecord(scripts)) {
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value !== "string" || !LIFECYCLE_SCRIPTS.has(name.toLowerCase())) {
        continue;
      }

      const labels: string[] = [];

      for (const shape of HOOK_PAYLOAD_SHAPES) {
        if (shape.pattern.test(value)) {
          labels.push(shape.label);
        }
      }

      if (labels.length > 0) {
        findings.push({
          path: file.path,
          detail: `It declares the install lifecycle script "${name}", whose body reaches outside the project: ${labels.sort().join(", ")}.`,
        });
      }
    }
  }

  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const group = manifest[section];

    if (!isRecord(group)) {
      continue;
    }

    for (const [name, spec] of Object.entries(group)) {
      if (typeof spec !== "string") {
        continue;
      }

      for (const shape of REMOTE_DEPENDENCY_SHAPES) {
        if (shape.pattern.test(spec)) {
          findings.push({
            path: file.path,
            detail: `It declares the dependency "${name}" as ${shape.label} ("${spec}"), so what is installed is not a published version of a named package.`,
          });
        }
      }
    }
  }

  return findings;
}

function requirementsFindings(file: ScannedFile): readonly Finding[] {
  const findings: Finding[] = [];

  for (const line of file.content.split("\n")) {
    if (!/(?:^|\s)(?:-e\s+|--index-url\s+|--extra-index-url\s+|https?:\/\/|git\+)/u.test(line)) {
      continue;
    }

    findings.push({
      path: file.path,
      detail: `It declares an installation source that is not the package index: ${line.trim()}.`,
    });
  }

  return findings;
}

function permissionFindings(files: readonly ScannedFile[]): readonly Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (!WORKFLOW_PATH.test(file.path)) {
      continue;
    }

    if (CI_WRITE_ALL.test(file.content) || CI_WRITE_ALL_MAP.test(file.content)) {
      findings.push({
        path: file.path,
        detail:
          "It grants write-all workflow permissions, which is every scope for every token the workflow holds.",
      });
    }

    if (PRIVILEGED_TRIGGER.test(file.content)) {
      findings.push({
        path: file.path,
        detail:
          "It is triggered by pull_request_target, issue_comment, workflow_run, or a manual dispatch, each of which can run this repository's code with this repository's credentials.",
      });
    }
  }

  return findings;
}

function extensionOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");

  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------------------------- */
/* The provider                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export interface ProjectSecurityReviewProviderOptions {
  /**
   * The project this provider may read. Defaults to `process.cwd()`. A kit that opens isolated
   * worktrees supplies a resolver, and the directory it names is chosen when the provider is
   * constructed rather than taken from a request, so a request cannot redirect a scan into a tree the
   * kit did not open.
   */
  readonly projectRoot?: string;
  /** Injectable millisecond clock, so evidence timestamps are reproducible in a test. */
  readonly clock?: () => number;
}

export class ProjectSecurityReviewProvider implements SecurityReviewProvider {
  readonly #root: string;
  readonly #clock: () => number;

  constructor(options: ProjectSecurityReviewProviderOptions = {}) {
    this.#root = resolve(options.projectRoot ?? process.cwd());
    this.#clock = options.clock ?? Date.now;
  }

  get projectRoot(): string {
    return this.#root;
  }

  async review(request: SecurityReviewRequest): Promise<SecurityReviewEvidence> {
    // The request's root is data the orchestrator supplies, so it is checked rather than followed.
    // This is the same per-call check the verification provider makes, and for the same reason: the
    // resolver says which tree is allowed and this provider still refuses anything else.
    const root = resolve(request.projectRoot);

    if (root !== this.#root) {
      throw new ProjectAdapterError(
        "command_invalid",
        `The security review request asked for project root "${request.projectRoot}" but this provider reads "${this.#root}".`,
      );
    }

    if (request.stage !== "security_review") {
      throw new ProjectAdapterError(
        "command_invalid",
        `The security review request asked for the "${request.stage}" stage, and this provider only decides "security_review".`,
      );
    }

    const { files, unreadable } = await scanChangeSet(root, request);
    const checks = this.#checks(files, unreadable, request);

    return {
      schemaVersion: 1,
      featureId: request.featureId,
      stage: "security_review",
      // Derived with the framework's own rule rather than a local copy of it, so a record this provider
      // produces and a record the framework validates cannot disagree about what the checks mean.
      status: deriveSecurityStatus(checks),
      revision: request.revision,
      workspaceFingerprint: request.workspaceFingerprint,
      projectRoot: root,
      workspaceId: request.workspaceId,
      approvedPatterns: [...request.approvedPatterns].sort(),
      changedPaths: [...request.changedPaths].sort(),
      checks,
      collectedAt: new Date(this.#clock()).toISOString(),
    };
  }

  #checks(
    files: readonly ScannedFile[],
    unreadable: readonly UnreadableFile[],
    request: SecurityReviewRequest,
  ): readonly SecurityCheckEvidence[] {
    const modifiedPaths = files
      .filter((file) => file.category === "modified")
      .map((file) => file.path)
      .sort();

    return [
      report({
        check: "hardcoded_secret",
        findings: secretFindings(files),
        unreadable,
        modifiedPaths,
        passedReason:
          "No issuer-formatted token, PEM private key block, or literal credential assignment is present in any file in the change set, once environment references, templates, and placeholder values are excluded.",
        failedFrame: `${SECURITY_CHECK_LABELS.hardcoded_secret}. A value written into a changed file is in the history of every clone of this repository from now on, and rotating the credential is the only way to remove it.`,
      }),
      report({
        check: "credential_file",
        findings: credentialFileFindings(files, request),
        unreadable,
        modifiedPaths,
        passedReason:
          "No file whose name marks it as a credential store is in the change set, unless the approved plan describes it.",
        failedFrame: `${SECURITY_CHECK_LABELS.credential_file}. The filename is the whole signal here, so the approved plan is what stands it down: a plan that legitimately adds a key store names it, and a plan that does not name it did not ask for one.`,
      }),
      report({
        check: "unexpected_executable",
        findings: executableFindings(files, request),
        unreadable,
        modifiedPaths,
        passedReason:
          "No file in the change set is executable, opens with an interpreter line, or carries a script extension, unless the approved plan describes it.",
        failedFrame: `${SECURITY_CHECK_LABELS.unexpected_executable}. A file that runs is a file the next person to check this repository out is asked to run, and the approved plan is the only statement of what this work required.`,
      }),
      report({
        check: "package_manager_hook",
        findings: packageHookFindings(files, request),
        unreadable,
        modifiedPaths,
        passedReason:
          "No manifest in the change set declares an install lifecycle script that reaches outside the project, or a dependency declared as something other than a published version.",
        failedFrame: `${SECURITY_CHECK_LABELS.package_manager_hook}. A lifecycle script runs on every machine that installs this project, before any of its code has had a say, so a change to one changes what a colleague's install does rather than what this feature does.`,
      }),
      report({
        check: "shell_execution",
        findings: shellExecutionFindings(files),
        unreadable,
        modifiedPaths,
        passedReason:
          "No file in the change set contains a construct that hands a string to a command interpreter, an interpreted string passed to eval, or a download piped into a shell.",
        failedFrame: `${SECURITY_CHECK_LABELS.shell_execution}. A string handed to a shell is the mechanism a command-injection defect needs, and the approved plan is the only statement of whether this work required one.`,
      }),
      report({
        check: "command_restriction_weakened",
        findings: restrictionFindings(files, request),
        unreadable,
        modifiedPaths,
        passedReason:
          "No file outside the approved plan's scope re-includes a path an ignore file excludes, or invokes git with --no-verify.",
        failedFrame: `${SECURITY_CHECK_LABELS.command_restriction_weakened}. A restriction that has been reopened is the restriction the next change is measured against, and it is reopened by the same edit that adds whatever the exclusion was protecting.`,
      }),
      report({
        check: "permission_broadening",
        findings: permissionFindings(files),
        unreadable,
        modifiedPaths,
        passedReason:
          "No workflow file in the change set grants write-all permissions, or is triggered by an event that runs this repository's code with this repository's credentials.",
        failedFrame: `${SECURITY_CHECK_LABELS.permission_broadening}. A workflow that runs on the repository's own credentials turns a change from outside into a write, and the workflow file is the whole of the difference between the two.`,
      }),
    ];
  }
}

export function createProjectSecurityReviewProvider(
  options: ProjectSecurityReviewProviderOptions = {},
): ProjectSecurityReviewProvider {
  return new ProjectSecurityReviewProvider(options);
}

/** The ceiling the scan enforces, exported so a caller can size its own expectations. */
export const SECURITY_SCAN_CEILING = SCAN_CEILING;
