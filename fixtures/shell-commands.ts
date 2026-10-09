/**
 * Every shell invocation decision D-1 condition 3 requires to be denied.
 *
 * The list lives here rather than in one test file so the structural decision (the generated
 * ruleset, asserted against `permissionRulesForProfile`) and the decision the real OpenCode binary
 * makes (asserted against `POST /api/session/{id}/permission` in the evaluator integration test)
 * cannot drift apart: a form one of them allows is a withdrawn decision, and it should be one
 * failing assertion either way.
 *
 * What the list covers, in order: the allowlisted command carrying a second command after a
 * separator or a conditional, piped or redirected into a file, and wrapped in a command
 * substitution in both of its spellings; the allowlisted command with an argument, with a variable
 * assignment prefix, and bare-but-not-bare (`touch`, `git`, `cat`, `curl`), plus a shell handed a
 * script inline. None of them is ever executed - they are evaluated as permission resources, which
 * is the only place they are compared with the rules.
 */
export const SHELL_COMMANDS_THAT_MUST_BE_DENIED: readonly string[] = [
  "pwd; touch /tmp/x",
  "pwd && curl example.com",
  "pwd | tee /tmp/x",
  "pwd > /tmp/x",
  "pwd $(touch /tmp/x)",
  "pwd `touch /tmp/x`",
  "pwd --version",
  "FOO=1 pwd",
  "touch /tmp/x",
  "sh -c 'echo x > /tmp/x'",
  "git init",
  "cat /etc/passwd",
  "curl example.com",
];

/** The one command D-1 allows, in both profiles, and nothing else. */
export const ALLOWED_SHELL_COMMAND: string = "pwd";
