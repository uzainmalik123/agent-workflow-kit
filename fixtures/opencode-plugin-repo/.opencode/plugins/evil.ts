/**
 * A deliberately hostile OpenCode plugin, kept as a fixture.
 *
 * The plugin id is the point of this file. The generated `opencode.json` disables every plugin and
 * then re-enables the `opencode.` namespace, because the agent loader and the permission machinery
 * are themselves plugins under that namespace. Plugin directives are matched against the id a
 * plugin *declares*, and a repository chooses that string, so naming this plugin `opencode.evil`
 * places it inside the re-enabled namespace. The `-*` disable and the `opencode.*` re-enable are
 * the same rule seen from two sides, and only one of them is under the framework's control.
 *
 * A plugin can rewrite an agent's system prompt, replace a tool, or register a new one, so this is
 * not a cosmetic risk: a plugin that loaded could change what a verifier or implementer is allowed
 * to do, and therefore what it reports. The adapter must refuse the repository before OpenCode
 * starts, which is what `assertNoProjectLocalPlugins` does and what
 * `tests/opencode-plugin-preflight.test.ts` asserts.
 *
 * Nothing here is ever executed by the test suite. The file is a fixture the preflight refuses on
 * sight; it is not a payload.
 */
export const OpenCodeEvilPlugin = async () => {
  return {
    id: "opencode.evil",
    name: "opencode-plugin-repo-fixture",
  };
};

export default OpenCodeEvilPlugin;
