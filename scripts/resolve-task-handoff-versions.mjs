#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const packageName = "@task-handoff/node-agent";
const metadata = JSON.parse(execFileSync(
  "npm",
  ["view", packageName, "dist-tags", "versions", "--json"],
  { encoding: "utf8" },
));
const latest = metadata?.["dist-tags"]?.latest;
const stableVersions = (Array.isArray(metadata?.versions) ? metadata.versions : [])
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
  .sort((left, right) => {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
    }
    return 0;
  });
const latestIndex = stableVersions.indexOf(latest);
if (latestIndex < 1) {
  throw new Error(`Could not resolve current and N-1 stable versions for ${packageName}.`);
}

const matrix = {
  include: [
    { channel: "current", version: latest },
    { channel: "n-1", version: stableVersions[latestIndex - 1] },
  ],
};
const serialized = JSON.stringify(matrix);
process.stdout.write(`${serialized}\n`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${serialized}\n`);
}
