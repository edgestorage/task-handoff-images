#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectMarketCatalog,
  loadSigningKey,
  serializeCatalog,
  signCatalog,
} from "./market-catalog/catalog.mjs";
import { writeCatalogSite } from "./market-catalog/site.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export function parseArgs(argv) {
  const options = { out: "pages", registry: undefined, namespace: undefined, revision: undefined, domain: undefined, metadata: undefined, historyTagLimit: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const [flag, inlineValue] = argument.includes("=") ? argument.split(/=(.*)/s, 2) : [argument, undefined];
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    switch (flag) {
      case "--out": options.out = value; break;
      case "--registry": options.registry = value; break;
      case "--namespace": options.namespace = value; break;
      case "--revision": options.revision = value; break;
      case "--domain": options.domain = value; break;
      case "--metadata": options.metadata = value; break;
      case "--history-tag-limit": options.historyTagLimit = Number(value); break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return options;
}

export function resolveRevision(env = process.env) {
  const fromEnv = env.TASK_HANDOFF_GIT_COMMIT?.trim();
  if (fromEnv) return fromEnv.slice(0, 16);
  try {
    return execFileSync("git", ["rev-parse", "--short=16", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "local";
  }
}

export async function buildMarketCatalogSite(options, env = process.env, deps = {}) {
  const metadataPath = path.resolve(options.metadata || env.TASK_HANDOFF_MARKET_METADATA || path.join(repoRoot, "market", "profiles.json"));
  const metadata = deps.metadata ?? JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const namespace = options.namespace || env.TASK_HANDOFF_MARKET_NAMESPACE || env.DOCKERHUB_USERNAME;
  if (!namespace) throw new Error("market catalog requires --namespace, TASK_HANDOFF_MARKET_NAMESPACE, or DOCKERHUB_USERNAME");

  const domain = options.domain || metadata.siteDomain;
  const registry = options.registry || env.TASK_HANDOFF_MARKET_REGISTRY || "docker.io";
  const skippedProfiles = [];
  const catalog = await collectMarketCatalog({
    metadata,
    namespace,
    registry,
    revision: options.revision || resolveRevision(env),
    generatedAt: deps.now,
    historyLimit: options.historyTagLimit ?? metadata.historyTagLimit,
    credentials: { username: env.DOCKERHUB_USERNAME, token: env.DOCKERHUB_TOKEN },
    fetchImpl: deps.fetchImpl,
    imageNames: deps.imageNames,
    env,
    log: (message, details) => {
      if (typeof details?.repository === "string") skippedProfiles.push(details.repository);
      process.stderr.write(`warning: ${message}${details?.repository ? ` (${details.repository})` : ""}\n`);
    },
  });
  const catalogBytes = serializeCatalog(catalog);

  const signingValue = env.TASK_HANDOFF_CATALOG_SIGNING_KEY;
  const keyId = env.TASK_HANDOFF_CATALOG_SIGNING_KEY_ID || "task-handoff-market-1";
  const privateKey = loadSigningKey(signingValue, deps.fs ?? fs);
  const signature = privateKey ? signCatalog(catalogBytes, privateKey, keyId) : undefined;
  if (!signature) process.stderr.write("warning: TASK_HANDOFF_CATALOG_SIGNING_KEY is not set; publishing an unsigned catalog\n");

  const site = writeCatalogSite({
    outDir: path.resolve(repoRoot, options.out),
    catalog,
    catalogBytes,
    signature,
    domain,
  });
  return { catalog, catalogBytes, signature, domain, skippedProfiles, outDir: path.resolve(repoRoot, options.out), site };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildMarketCatalogSite(options);
  process.stdout.write([
    `market catalog: ${result.catalog.items.length} images`,
    `skipped: ${result.skippedProfiles.length ? result.skippedProfiles.join(", ") : "none"}`,
    `revision: ${result.catalog.revision}`,
    `domain: ${result.domain}`,
    `signed: ${result.signature ? "yes" : "no"}`,
    `output: ${result.outDir}`,
  ].join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
