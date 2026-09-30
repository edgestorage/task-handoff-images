#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ALL_PROFILES = ["codex", "obscura", "opencode", "ai", "webcap", "bcap", "browser"];

const STAGE_PROFILES = new Map([
  ["runtime-base", ALL_PROFILES],
  ["runtime-core", ALL_PROFILES],
  ["profile-codex-root", ["codex", "obscura", "ai", "webcap", "bcap", "browser"]],
  ["profile-obscura-root", ["obscura"]],
  ["profile-opencode-root", ["opencode"]],
  ["profile-ai-root", ["ai", "webcap", "bcap", "browser"]],
  ["profile-gui-root", ["webcap", "bcap", "browser"]],
  ["profile-webcap-root", ["webcap"]],
  ["profile-bcap-root", ["bcap"]],
  ["profile-browser-root", ["browser"]],
  ["profile-codex", ["codex"]],
  ["profile-obscura", ["obscura"]],
  ["profile-opencode", ["opencode"]],
  ["profile-ai", ["ai"]],
  ["profile-webcap", ["webcap"]],
  ["profile-bcap", ["bcap"]],
  ["profile-browser", ["browser"]],
]);

function ordered(profiles) {
  const selected = new Set(profiles);
  return ALL_PROFILES.filter((profile) => selected.has(profile));
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function dockerStageAtLine(contents, lineNumber) {
  let stage = null;
  const lines = contents.split("\n");
  for (let index = 0; index < Math.min(lineNumber, lines.length); index += 1) {
    const match = lines[index].match(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/i);
    if (match) stage = match[1];
  }
  return stage;
}

export function profilesForDockerDiff(oldDockerfile, newDockerfile, unifiedDiff) {
  const profiles = new Set();
  let foundHunk = false;

  for (const line of unifiedDiff.split("\n")) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    foundHunk = true;
    const ranges = [
      { contents: oldDockerfile, start: Number(match[1]), count: Number(match[2] ?? 1) },
      { contents: newDockerfile, start: Number(match[3]), count: Number(match[4] ?? 1) },
    ];

    for (const { contents, start, count } of ranges) {
      if (count === 0) continue;
      const firstStage = dockerStageAtLine(contents, start);
      const lastStage = dockerStageAtLine(contents, start + count - 1);
      for (const stage of [firstStage, lastStage]) {
        const affected = STAGE_PROFILES.get(stage);
        if (!affected) return ALL_PROFILES;
        for (const profile of affected) profiles.add(profile);
      }
    }
  }

  return foundHunk ? ordered(profiles) : [];
}

export function profilesForPaths(paths) {
  const profiles = new Set();
  for (const path of paths) {
    let affected = [];
    if (path === ".dockerignore" || path === "docker/image-entrypoint.sh" || path === "docker/healthcheck.sh") {
      affected = ALL_PROFILES;
    } else if (path === "docker/optional-apps.sh") {
      affected = ["webcap", "bcap", "browser"];
    } else if (path === "LICENSE") {
      affected = ["obscura"];
    } else if (path.startsWith("docker/")) {
      affected = ALL_PROFILES;
    }
    for (const profile of affected) profiles.add(profile);
  }
  return ordered(profiles);
}

export function mergeProfiles(...groups) {
  return ordered(groups.flat());
}

function readAtRevision(revision, path) {
  try {
    return git(["show", `${revision}:${path}`]);
  } catch {
    return "";
  }
}

export function resolveChangedProfiles(base, head) {
  if (!base) return ALL_PROFILES;

  const paths = git(["diff", "--name-only", base, head]).split("\n").filter(Boolean);
  let profiles = profilesForPaths(paths);
  if (paths.includes("Dockerfile")) {
    const oldDockerfile = readAtRevision(base, "Dockerfile");
    const newDockerfile = readAtRevision(head, "Dockerfile");
    const dockerDiff = git(["diff", "--unified=0", "--format=", base, head, "--", "Dockerfile"]);
    profiles = mergeProfiles(profiles, profilesForDockerDiff(oldDockerfile, newDockerfile, dockerDiff));
  }
  return profiles;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error("Usage: resolve-changed-image-profiles.mjs --base <revision-or-empty> --head <revision>");
    }
    values[key.slice(2)] = argv[index + 1];
  }
  if (values.head === undefined || values.base === undefined) {
    throw new Error("Both --base and --head are required");
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { base, head } = parseArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(resolveChangedProfiles(base, head))}\n`);
}
