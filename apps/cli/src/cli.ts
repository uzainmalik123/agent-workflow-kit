#!/usr/bin/env node
import { createCli } from "./commands.js";

// The real stack is the default here and nowhere else: the commands take the stack factory from
// `createCli`, so the only way to run against a fake executor is to inject one, which is what the
// CLI tests do.
createCli().parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
