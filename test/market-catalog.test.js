const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const profilesPath = path.join(root, "market", "profiles.json");
const metadata = JSON.parse(fs.readFileSync(profilesPath, "utf8"));

const catalog = () => import("../scripts/market-catalog/catalog.mjs");
const site = () => import("../scripts/market-catalog/site.mjs");

const digest = (letter) => `sha256:${letter.repeat(64)}`;

function hubTag(name, options = {}) {
  return {
    name,
    digest: options.digest,
    tag_status: options.tagStatus || "active",
    last_updated: options.updated || "2026-09-01T10:00:00.000000Z",
    images: options.images || [
      { os: "linux", architecture: "amd64", digest: digest("a"), size: 1024 },
      { os: "linux", architecture: "arm64", digest: digest("b"), size: 2048 },
    ],
  };
}

function fakeFetch(tags) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { results: tags, next: null };
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("market profiles stay in sync with Dockerfile labels", async () => {
  const { ALL_PROFILES } = await import("../scripts/resolve-changed-image-profiles.mjs");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const declared = [...dockerfile.matchAll(/LABEL io\.task-handoff\.image\.profile=(\S+)\nLABEL io\.task-handoff\.image\.capabilities=(\S+)/g)]
    .map((match) => ({ profile: match[1], capabilities: match[2].split(",") }));

  assert.deepEqual(declared.map((entry) => entry.profile), ALL_PROFILES);
  assert.deepEqual(metadata.profiles.map((entry) => entry.profile), ALL_PROFILES);
  assert.deepEqual(metadata.profiles.map((entry) => entry.slug), ALL_PROFILES);
  for (const entry of declared) {
    const profile = metadata.profiles.find((candidate) => candidate.profile === entry.profile);
    assert.ok(profile, `missing market metadata for ${entry.profile}`);
    assert.deepEqual(profile.capabilities, entry.capabilities, `capabilities drifted for ${entry.profile}`);
  }
  const ids = metadata.profiles.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("selectCatalogTags keeps channels plus the newest version tags", async () => {
  const { selectCatalogTags } = await catalog();
  const selected = selectCatalogTags([
    "latest",
    "alpha",
    "beta",
    "1.2.3",
    "docker-sha-abcdef",
    "ci-1234567",
    "v0.9.0",
    "v1.0.0",
    "v1.1.0",
    "v1.2.0",
    "v1.2.0-alpha.1",
    "v1.2.0-alpha.2",
  ]);
  assert.deepEqual(selected, [
    "latest",
    "alpha",
    "beta",
    "v1.2.0",
    "v1.2.0-alpha.2",
    "v1.2.0-alpha.1",
    "v1.1.0",
    "v1.0.0",
    "v0.9.0",
  ]);
});

test("mapHubTag maps registry facts onto the market tag model", async () => {
  const { mapHubTag } = await catalog();
  const tag = mapHubTag(hubTag("v1.4.0", { digest: digest("f") }), {
    registry: "docker.io",
    namespace: "huadream",
    imageName: "task-handoff-controlled-codex",
  });
  assert.equal(tag.name, "v1.4.0");
  assert.equal(tag.version, "1.4.0");
  assert.equal(tag.reference, "huadream/task-handoff-controlled-codex:v1.4.0");
  assert.equal(tag.manifestDigest, digest("f"));
  assert.equal(tag.publishedAt, "2026-09-01T10:00:00.000Z");
  assert.deepEqual(tag.platforms, [
    { os: "linux", architecture: "amd64", digest: digest("a"), downloadSizeBytes: 1024 },
    { os: "linux", architecture: "arm64", digest: digest("b"), downloadSizeBytes: 2048 },
  ]);

  const single = mapHubTag(hubTag("latest", { images: [{ os: "linux", architecture: "amd64", digest: digest("c"), size: 512 }] }), {
    registry: "docker.io",
    namespace: "huadream",
    imageName: "task-handoff-controlled-codex",
  });
  assert.equal(single.manifestDigest, digest("c"));
  assert.equal(single.status, "active");

  const yanked = mapHubTag(hubTag("latest", { tagStatus: "inactive" }), {
    registry: "docker.io",
    namespace: "huadream",
    imageName: "task-handoff-controlled-codex",
  });
  assert.equal(yanked.status, "yanked");

  const ignored = mapHubTag(hubTag("latest", { images: [{ os: "unknown", architecture: "unknown", digest: digest("d") }] }), {
    registry: "docker.io",
    namespace: "huadream",
    imageName: "task-handoff-controlled-codex",
  });
  assert.deepEqual(ignored.platforms, []);
});

test("collectMarketCatalog builds a remote catalog snapshot from registry data", async () => {
  const { collectMarketCatalog } = await catalog();
  const fetchImpl = fakeFetch([hubTag("latest", { digest: digest("e") }), hubTag("v1.0.0", { digest: digest("f") })]);
  const snapshot = await collectMarketCatalog({
    metadata,
    namespace: "huadream",
    registry: "docker.io",
    revision: "abc123",
    generatedAt: "2026-09-30T00:00:00.000Z",
    credentials: { username: "huadream", token: "token" },
    fetchImpl,
  });

  assert.equal(snapshot.protocolVersion, metadata.protocolVersion);
  assert.equal(snapshot.catalogId, metadata.catalogId);
  assert.equal(snapshot.source, "remote");
  assert.equal(snapshot.revision, "abc123");
  assert.equal(snapshot.items.length, metadata.profiles.length);
  const codex = snapshot.items.find((item) => item.slug === "codex");
  assert.equal(codex.repository, "huadream/task-handoff-controlled-codex");
  assert.equal(codex.defaultTag, "latest");
  assert.deepEqual(codex.tags.map((tag) => tag.name), ["latest", "v1.0.0"]);
  assert.equal(fetchImpl.calls.length, metadata.profiles.length);
  assert.match(fetchImpl.calls[0].init.headers.authorization, /^Basic /);

  const obscura = snapshot.items.find((item) => item.slug === "obscura");
  assert.deepEqual(obscura.capabilities, ["terminal", "codex", "obscura"]);
});

test("collectMarketCatalog fails when a repository has no latest tag", async () => {
  const { collectMarketCatalog } = await catalog();
  await assert.rejects(
    collectMarketCatalog({
      metadata: { ...metadata, profiles: [metadata.profiles[0]] },
      namespace: "huadream",
      registry: "docker.io",
      revision: "abc123",
      fetchImpl: fakeFetch([hubTag("v1.0.0", {})]),
    }),
    /no latest tag/,
  );
});

test("collectMarketCatalog skips profiles that are not published yet", async () => {
  const { collectMarketCatalog } = await catalog();
  const published = fakeFetch([hubTag("latest", { digest: digest("e") })]);
  const fetchImpl = async (url, init) => {
    if (String(url).includes("task-handoff-controlled-obscura")) return { ok: false, status: 404, async json() { return { message: "object not found" }; } };
    return published(url, init);
  };
  const warnings = [];
  const snapshot = await collectMarketCatalog({
    metadata,
    namespace: "huadream",
    registry: "docker.io",
    revision: "abc123",
    fetchImpl,
    log: (message, details) => warnings.push({ message, details }),
  });

  assert.equal(snapshot.items.length, metadata.profiles.length - 1);
  assert.equal(snapshot.items.some((item) => item.slug === "obscura"), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].details.repository, "huadream/task-handoff-controlled-obscura");
  assert.match(warnings[0].message, /no published tags/);
});

test("catalog signing round-trips through ed25519", async () => {
  const { loadSigningKey, signCatalog } = await catalog();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const bytes = '{"items":[]}\n';
  const loaded = loadSigningKey(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  const signature = JSON.parse(signCatalog(bytes, loaded, "test-key"));
  assert.equal(signature.alg, "ed25519");
  assert.equal(signature.keyId, "test-key");
  assert.equal(signature.catalogSha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(crypto.verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature.signature, "base64")), true);
  assert.equal(crypto.verify(null, Buffer.from(`${bytes} `), publicKey, Buffer.from(signature.signature, "base64")), false);
});

test("writeCatalogSite publishes catalog bytes, CNAME, and image documents", async () => {
  const { serializeCatalog } = await catalog();
  const { writeCatalogSite } = await site();
  const snapshot = {
    protocolVersion: metadata.protocolVersion,
    catalogId: metadata.catalogId,
    revision: "abc123",
    source: "remote",
    generatedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-10-07T00:00:00.000Z",
    items: [{
      id: "market_taskhandoff_codex",
      publisher: "task-handoff",
      slug: "codex",
      name: "TaskHandoff Codex",
      description: "Minimal Codex runtime with terminal and Codex.",
      cover: { kind: "builtin", key: "default-image-cover" },
      repository: "huadream/task-handoff-controlled-codex",
      defaultTag: "latest",
      tags: [{ name: "latest", reference: "huadream/task-handoff-controlled-codex:latest", platforms: [], status: "active" }],
      capabilities: ["terminal", "codex"],
      optionalApps: ["terminal-tty"],
      defaultEnv: {},
      labels: { "task-handoff.image.kind": "controlled-instance", "task-handoff.image.profile": "codex" },
      status: "active",
    }],
  };
  const bytes = serializeCatalog(snapshot);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "market-site-"));
  const result = writeCatalogSite({ outDir, catalog: snapshot, catalogBytes: bytes, signature: '{"alg":"ed25519"}\n', domain: metadata.siteDomain });

  assert.equal(fs.readFileSync(path.join(outDir, "CNAME"), "utf8"), `${metadata.siteDomain}\n`);
  assert.equal(fs.existsSync(path.join(outDir, ".nojekyll")), true);
  assert.equal(fs.readFileSync(path.join(outDir, "market/v1/catalog.json"), "utf8"), bytes);
  assert.equal(fs.existsSync(path.join(outDir, "market/v1/catalog.sig")), true);
  assert.equal(result.images.length, 1);
  assert.equal(fs.readFileSync(path.join(outDir, "market/v1/images/codex.json"), "utf8"), `${JSON.stringify(snapshot.items[0], null, 2)}\n`);
  const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.match(html, /images\.thandoff\.com/);
  assert.match(html, /TaskHandoff Codex/);
  assert.match(html, /market\/v1\/catalog\.json/);
});

test("Pages workflows deploy the catalog through the shared action", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");
  const pagesWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  const action = fs.readFileSync(path.join(root, ".github", "actions", "publish-market-catalog", "action.yml"), "utf8");

  assert.match(workflow, /publish-market-catalog:[\s\S]*needs: \[detect-changes, promote-release\]/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/publish-market-catalog/);
  assert.match(workflow, /pages: write/);
  assert.match(pagesWorkflow, /workflow_dispatch:/);
  assert.match(pagesWorkflow, /uses: \.\/\.github\/actions\/publish-market-catalog/);
  assert.match(action, /node scripts\/build-market-catalog\.mjs/);
  assert.match(action, /actions\/deploy-pages@v4/);
});
