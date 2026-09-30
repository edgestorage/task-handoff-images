const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const resolverUrl = pathToFileURL(path.resolve(__dirname, "..", "scripts", "resolve-changed-image-profiles.mjs"));

test("profile path changes select only dependent images", async () => {
  const { profilesForPaths } = await import(resolverUrl);

  assert.deepEqual(profilesForPaths(["docker/optional-apps.sh"]), ["webcap", "browser"]);
  assert.deepEqual(profilesForPaths(["LICENSE"]), ["obscura"]);
  assert.deepEqual(profilesForPaths(["README.md", "test/dockerfile.test.js"]), []);
  assert.deepEqual(profilesForPaths(["docker/image-entrypoint.sh"]), [
    "codex",
    "obscura",
    "opencode",
    "ai",
    "webcap",
    "browser",
  ]);
});

test("Dockerfile stage changes follow the image inheritance graph", async () => {
  const { profilesForDockerDiff } = await import(resolverUrl);
  const dockerfile = [
    "FROM node AS runtime-base",
    "RUN true",
    "FROM runtime-base AS profile-codex-root",
    "RUN true",
    "FROM profile-codex-root AS profile-obscura-root",
    "RUN true",
    "FROM profile-codex-root AS profile-codex",
    "RUN true",
    "FROM profile-obscura-root AS profile-obscura",
    "RUN true",
  ].join("\n");

  assert.deepEqual(
    profilesForDockerDiff(dockerfile, dockerfile, "@@ -6 +6 @@\n-RUN false\n+RUN true"),
    ["obscura"],
  );
  assert.deepEqual(
    profilesForDockerDiff(dockerfile, dockerfile, "@@ -4 +4 @@\n-RUN false\n+RUN true"),
    ["codex", "obscura", "ai", "webcap", "browser"],
  );
  assert.deepEqual(
    profilesForDockerDiff(dockerfile, dockerfile, "@@ -2 +2 @@\n-RUN false\n+RUN true"),
    ["codex", "obscura", "opencode", "ai", "webcap", "browser"],
  );
});
