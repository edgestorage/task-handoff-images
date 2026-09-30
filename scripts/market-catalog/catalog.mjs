#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";

export const DEFAULT_REGISTRY = "docker.io";
export const CHANNEL_TAGS = ["latest", "alpha", "beta"];
export const DEFAULT_HISTORY_TAG_LIMIT = 6;

const VERSION_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const DOCKER_HUB_API = "https://hub.docker.com/v2/repositories";

function normalizeDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function validTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function parseVersionTag(name) {
  const match = VERSION_TAG_PATTERN.exec(String(name).trim());
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    name: match[0],
    version: match[0].slice(1),
    channel: prerelease ? prerelease.split(/[.-]/)[0] : "stable",
    numbers: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease || undefined,
  };
}

function compareVersionTags(left, right) {
  for (let index = 0; index < left.numbers.length; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return right.numbers[index] - left.numbers[index];
  }
  if (!left.prerelease && right.prerelease) return -1;
  if (left.prerelease && !right.prerelease) return 1;
  if (!left.prerelease && !right.prerelease) return 0;
  return right.prerelease.localeCompare(left.prerelease, "en", { numeric: true });
}

export function selectCatalogTags(names, options = {}) {
  const historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : DEFAULT_HISTORY_TAG_LIMIT;
  const available = new Set(names.map((name) => String(name).trim()).filter(Boolean));
  const selected = [];
  const push = (name) => {
    if (name && available.has(name) && !selected.includes(name)) selected.push(name);
  };

  for (const channel of CHANNEL_TAGS) push(channel);

  const versions = [...available]
    .map(parseVersionTag)
    .filter(Boolean)
    .sort(compareVersionTags)
    .slice(0, Math.max(historyLimit, 0));
  for (const version of versions) push(version.name);

  return selected;
}

export function repositoryFor(registry, namespace, imageName) {
  const host = String(registry || DEFAULT_REGISTRY).trim().toLowerCase();
  const path = `${namespace}/${imageName}`;
  return host === DEFAULT_REGISTRY ? path : `${host}/${path}`;
}

export function referenceFor(registry, namespace, imageName, tag) {
  return `${repositoryFor(registry, namespace, imageName)}:${tag}`;
}

export function mapHubTag(hubTag, context) {
  const name = String(hubTag.name);
  const platforms = [];
  const seen = new Set();
  for (const image of Array.isArray(hubTag.images) ? hubTag.images : []) {
    const os = typeof image?.os === "string" ? image.os.trim() : "";
    const architecture = typeof image?.architecture === "string" ? image.architecture.trim() : "";
    if (!os || !architecture || os === "unknown" || architecture === "unknown") continue;
    const key = `${os}/${architecture}`;
    if (seen.has(key)) continue;
    seen.add(key);
    platforms.push({
      os,
      architecture,
      ...(normalizeDigest(image.digest) ? { digest: normalizeDigest(image.digest) } : {}),
      ...(positiveInteger(image.size) ? { downloadSizeBytes: image.size } : {}),
    });
  }
  platforms.sort((left, right) => `${left.os}/${left.architecture}`.localeCompare(`${right.os}/${right.architecture}`));

  const version = parseVersionTag(name);
  const singlePlatformDigest = platforms.length === 1 ? platforms[0].digest : undefined;
  const manifestDigest = normalizeDigest(hubTag.digest) || singlePlatformDigest;

  return {
    name,
    ...(version ? { version: version.version } : {}),
    reference: referenceFor(context.registry, context.namespace, context.imageName, name),
    ...(manifestDigest ? { manifestDigest } : {}),
    ...(validTimestamp(hubTag.last_updated) ? { publishedAt: validTimestamp(hubTag.last_updated) } : {}),
    platforms,
    status: hubTag.tag_status === "inactive" ? "yanked" : "active",
  };
}

export function buildMarketImage(metadata, tags, context) {
  const existing = tags.filter((tag) => tag.status === "active");
  const selectable = existing.length ? existing : tags;
  if (!selectable.length) throw new Error(`image profile ${metadata.profile} has no catalog tags`);
  const defaultTag = selectable.find((tag) => tag.name === "latest")?.name
    || selectable.find((tag) => parseVersionTag(tag.name))?.name
    || selectable[0].name;

  return {
    id: metadata.id,
    publisher: context.publisher,
    slug: metadata.slug,
    name: metadata.name,
    description: metadata.description,
    ...(metadata.localizedDescriptions ? { localizedDescriptions: metadata.localizedDescriptions } : {}),
    cover: { kind: "builtin", key: "default-image-cover" },
    repository: repositoryFor(context.registry, context.namespace, context.imageName),
    defaultTag,
    tags: selectable,
    capabilities: metadata.capabilities,
    optionalApps: metadata.optionalApps,
    defaultEnv: {},
    labels: {
      "task-handoff.image.kind": "controlled-instance",
      "task-handoff.image.profile": metadata.profile,
    },
    status: "active",
  };
}

export function buildCatalogSnapshot(input) {
  const generatedAt = new Date(input.generatedAt ?? Date.now()).toISOString();
  const expiresAt = new Date(input.expiresAt ?? Date.parse(generatedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    protocolVersion: input.protocolVersion,
    catalogId: input.catalogId,
    revision: input.revision,
    source: "remote",
    generatedAt,
    expiresAt,
    items: input.items,
  };
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function dockerHubAuthHeader(credentials) {
  if (!credentials?.username || !credentials?.token) return undefined;
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64")}`;
}

export function imageNameForProfile(profile, env = process.env) {
  const override = env[`DOCKERHUB_${profile.toUpperCase()}_IMAGE_NAME`];
  return override && override.trim() ? override.trim() : `task-handoff-controlled-${profile}`;
}

export async function fetchRepositoryTagPage(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = input.url
    ? new URL(input.url)
    : new URL(`${DOCKER_HUB_API}/${input.namespace}/${input.imageName}/tags`);
  if (!input.url) {
    url.searchParams.set("page_size", String(input.pageSize ?? 100));
    url.searchParams.set("ordering", "last_updated");
    if (input.page) url.searchParams.set("page", String(input.page));
  }

  const headers = { accept: "application/json" };
  const authorization = dockerHubAuthHeader(input.credentials);
  if (authorization) headers.authorization = authorization;

  const response = await fetchImpl(url, { headers });
  if (response.status === 404) return { results: [], next: undefined, missing: true };
  if (!response.ok) {
    throw new Error(`Docker Hub tag listing failed for ${input.namespace}/${input.imageName}: HTTP ${response.status}`);
  }
  const payload = await response.json();
  return {
    results: Array.isArray(payload?.results) ? payload.results : [],
    next: typeof payload?.next === "string" && payload.next ? payload.next : undefined,
  };
}

export async function fetchRepositoryTags(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxPages = input.maxPages ?? 5;
  const results = [];
  let url;
  for (let page = 0; page < maxPages; page += 1) {
    const current = await fetchRepositoryTagPage({ ...input, fetchImpl, url, page: page + 1 });
    if (current.missing) return [];
    results.push(...current.results);
    if (!current.next) break;
    url = current.next;
  }
  return results;
}

export async function collectMarketCatalog(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = input.registry ?? DEFAULT_REGISTRY;
  const historyLimit = input.historyLimit ?? DEFAULT_HISTORY_TAG_LIMIT;
  const items = [];
  const missing = [];
  const log = input.log ?? (() => {});

  for (const metadata of input.metadata.profiles) {
    const imageName = input.imageNames?.[metadata.profile] ?? imageNameForProfile(metadata.profile, input.env ?? process.env);
    const hubTags = await fetchRepositoryTags({
      fetchImpl,
      namespace: input.namespace,
      imageName,
      credentials: input.credentials,
      pageSize: input.pageSize,
      maxPages: input.maxPages,
    });
    const selected = selectCatalogTags(hubTags.map((tag) => tag.name), { historyLimit });
    if (!selected.length) {
      const repository = `${input.namespace}/${imageName}`;
      log(`image repository has no published tags yet; skipping ${metadata.profile}`, { profile: metadata.profile, repository });
      continue;
    }
    if (!selected.includes("latest")) missing.push(`${input.namespace}/${imageName}`);
    const tags = selected
      .map((name) => hubTags.find((tag) => tag.name === name))
      .filter(Boolean)
      .map((tag) => mapHubTag(tag, { registry, namespace: input.namespace, imageName }));
    items.push(buildMarketImage(metadata, tags, {
      registry,
      namespace: input.namespace,
      imageName,
      publisher: input.metadata.publisher,
    }));
  }

  if (missing.length) {
    throw new Error(`image repositories have no latest tag yet: ${missing.join(", ")}`);
  }

  return buildCatalogSnapshot({
    protocolVersion: input.metadata.protocolVersion,
    catalogId: input.metadata.catalogId,
    revision: input.revision,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    items,
  });
}

export function signCatalog(catalogBytes, privateKey, keyId) {
  const signature = crypto.sign(null, Buffer.from(catalogBytes), privateKey).toString("base64");
  return `${JSON.stringify({
    alg: "ed25519",
    keyId,
    catalogSha256: crypto.createHash("sha256").update(catalogBytes).digest("hex"),
    signature,
  }, null, 2)}\n`;
}

export function loadSigningKey(value, fsImpl = fs) {
  if (!value || !String(value).trim()) return undefined;
  const raw = String(value).trim();
  if (raw.includes("-----BEGIN") && raw.includes("PRIVATE KEY")) {
    return crypto.createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" });
  }
  if (fsImpl.existsSync(raw)) {
    return crypto.createPrivateKey({ key: fsImpl.readFileSync(raw, "utf8"), format: "pem" });
  }
  return crypto.createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
}
