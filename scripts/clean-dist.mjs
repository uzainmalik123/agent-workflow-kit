#!/usr/bin/env node
import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function findDistDirs(dir, results = []) {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === "dist") {
        results.push(full);
      } else {
        const st = statSync(full, { throwIfNoEntry: false });
        if (st?.isDirectory() && entry !== "node_modules") {
          findDistDirs(full, results);
        }
      }
    }
  } catch {
    // ignore
  }
  return results;
}

const distDirs = findDistDirs(root);
for (const d of distDirs) {
  if (existsSync(d)) {
    console.log(`Removing ${d}`);
    rmSync(d, { recursive: true, force: true });
  }
}