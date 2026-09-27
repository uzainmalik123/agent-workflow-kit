# Untrusted plugin fixture

A repository that ships its own OpenCode plugin under the trusted `opencode.*` namespace.

Used by `tests/opencode-plugin-preflight.test.ts` to prove the adapter refuses to launch OpenCode
here, and that the transport is never invoked. The plugin file is never executed.
