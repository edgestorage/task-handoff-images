#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pinsPath = path.join(scriptDir, "native-app-pins.json");
const registries = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
const maxRedirects = 8;
const downloadTimeoutMs = 10 * 60_000;

function fail(message) {
  throw new Error(message);
}

function artifactError(code, message) {
  return Object.assign(new Error(message), { nativeArtifactCode: code });
}

function parseArgs(argv) {
  const [appId, ...rest] = argv;
  if (!appId || appId.startsWith("--")) fail("Usage: install-native-app.mjs <app-id> [--arch <arch>] [--print-launcher]");
  const options = { appId, arch: process.arch, printLauncher: false };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--arch") {
      options.arch = rest[++index];
    } else if (value === "--print-launcher") {
      options.printLauncher = true;
    } else {
      fail(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function normalizeArch(value) {
  switch ((value || "").toLowerCase()) {
    case "x64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      fail(`Unsupported architecture: ${value || "unknown"}`);
  }
}

function loadPin(appId, arch) {
  const pins = JSON.parse(fs.readFileSync(pinsPath, "utf8"));
  const app = pins[appId];
  if (!app || typeof app.version !== "string" || !app.targets || typeof app.targets !== "object") {
    fail(`Missing native package pins for ${appId}.`);
  }
  const target = app.targets[arch];
  if (!target) fail(`Missing native package target ${appId}/${arch}.`);
  for (const key of ["package", "packageVersion", "integrity", "launchPath"]) {
    if (typeof target[key] !== "string" || !target[key]) fail(`Invalid ${appId}/${arch} ${key}.`);
  }
  return { version: app.version, ...target };
}

function managedAppRoot() {
  return path.resolve(process.env.TASK_HANDOFF_MANAGED_APP_ROOT || path.join(process.env.TASK_HANDOFF_DATA_DIR || "/data/task-handoff", "managed-apps"));
}

function nativeAppRoot(root, appId) {
  return path.join(root, "native", appId);
}

function launcherPath(root, appId, launchPath) {
  return path.join(nativeAppRoot(root, appId), launchPath);
}

function validRelativePath(value) {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  if (path.posix.normalize(value) !== value) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function validatePin(appId, pin) {
  if (!validRelativePath(pin.launchPath)) fail(`Invalid launcher path for ${appId}.`);
  const match = /^sha(256|512)-([A-Za-z0-9+/]+={0,2})$/.exec(pin.integrity);
  if (!match) fail(`Invalid integrity for ${appId}.`);
  const digest = Buffer.from(match[2], "base64");
  if (digest.length !== (match[1] === "256" ? 32 : 64) || digest.toString("base64") !== match[2]) {
    fail(`Invalid integrity digest for ${appId}.`);
  }
}

function tarballUrl(registry, pin) {
  const base = registry.replace(/\/+$/, "");
  const leaf = pin.package.split("/").at(-1);
  return `${base}/${pin.package}/-/${leaf}-${pin.packageVersion}.tgz`;
}

function assertHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail(`Refusing non-canonical HTTPS artifact URL: ${value}`);
  }
  return url;
}

async function download(url, destination, integrity) {
  const [algorithm, expected] = integrity.split("-", 2);
  const hash = crypto.createHash(algorithm);
  let current = assertHttpsUrl(url);
  let response;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    try {
      response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(downloadTimeoutMs) });
    } catch (error) {
      throw artifactError("source_unavailable", `Artifact request failed for ${current}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw artifactError("artifact_invalid", `Artifact redirect from ${current} has no location.`);
    if (redirects === maxRedirects) throw artifactError("artifact_invalid", `Artifact download exceeded ${maxRedirects} redirects.`);
    current = assertHttpsUrl(new URL(location, current).toString());
  }
  if (!response?.ok || !response.body) {
    throw artifactError("source_unavailable", `Artifact download failed (${response?.status || "no response"}): ${current}`);
  }
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hashing, fs.createWriteStream(destination, { mode: 0o600 }));
  const actual = hash.digest("base64");
  if (actual !== expected) throw artifactError("artifact_invalid", `Artifact integrity mismatch: expected ${expected}, received ${actual}.`);
}

function tarEntries(artifact) {
  return execFileSync("tar", ["-tzf", artifact], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })
    .split("\n")
    .filter(Boolean);
}

function validateTarball(artifact) {
  const verbose = execFileSync("tar", ["-tvzf", artifact], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  for (const line of verbose.split("\n").filter(Boolean)) {
    if (!/^[d-]/.test(line)) fail("Native package tarball contains a link or unsupported entry type.");
  }
  const entries = tarEntries(artifact);
  if (!entries.length) fail("Native package tarball is empty.");
  for (const entry of entries) {
    if (entry === "package/") continue;
    if (!entry.startsWith("package/")) fail(`Native package tarball has an invalid root entry: ${entry}`);
    const relative = entry.slice("package/".length).replace(/\/$/, "");
    if (relative && !validRelativePath(relative)) fail(`Native package tarball has an unsafe path: ${entry}`);
  }
}

function extractTarball(artifact, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xzf", artifact, "-C", destination, "--strip-components=1", "--no-same-owner", "--no-same-permissions"], {
    env: { ...process.env, LC_ALL: "C" },
  });
}

function walkFiles(root, current = root, files = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`Native package contains a symlink: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) {
      walkFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      fail(`Native package contains an unsupported file type: ${path.relative(root, absolute)}`);
    }
  }
  return files;
}

function verifyLauncher(extracted, pin) {
  const candidate = path.resolve(extracted, pin.launchPath);
  const root = fs.realpathSync(extracted);
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    fail(`Native launcher is missing: ${pin.launchPath}`);
  }
  const resolved = stat.isFile() ? fs.realpathSync(candidate) : undefined;
  if (!stat.isFile() || !resolved || !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`Native launcher is not a regular file inside the package: ${pin.launchPath}`);
  }
  fs.chmodSync(candidate, 0o755);
  execFileSync(candidate, ["--version"], { stdio: "inherit", env: { ...process.env, HOME: process.env.HOME || "/home/agent" } });
  return candidate;
}

function writeManifest(extracted, target, appId, pin, files) {
  const manifest = {
    schemaVersion: 1,
    appId,
    version: pin.version,
    package: pin.package,
    packageVersion: pin.packageVersion,
    integrity: pin.integrity,
    installRoot: target,
    launchPath: pin.launchPath,
    files: [...new Set([...files, "managed-app.json"])].sort(),
  };
  fs.writeFileSync(path.join(extracted, "managed-app.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function replaceTree(extracted, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const previous = `${target}.previous-${crypto.randomUUID()}`;
  if (fs.existsSync(target)) fs.renameSync(target, previous);
  try {
    fs.renameSync(extracted, target);
  } catch (error) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(previous)) fs.renameSync(previous, target);
    throw error;
  }
  fs.rmSync(previous, { recursive: true, force: true });
}

async function install(appId, arch) {
  const pin = loadPin(appId, arch);
  validatePin(appId, pin);
  const root = managedAppRoot();
  const target = nativeAppRoot(root, appId);
  const staging = path.join(root, "native", ".staging", `${appId}-${crypto.randomUUID()}`);
  const artifact = path.join(staging, "artifact.tgz");
  const extracted = path.join(staging, "package");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    let lastError;
    let downloaded = false;
    for (const registry of registries) {
      try {
        await download(tarballUrl(registry, pin), artifact, pin.integrity);
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Native package source ${registry} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (error?.nativeArtifactCode !== "source_unavailable") throw error;
      }
    }
    if (!downloaded) throw lastError || new Error(`Could not download ${appId}.`);
    validateTarball(artifact);
    extractTarball(artifact, extracted);
    verifyLauncher(extracted, pin);
    writeManifest(extracted, target, appId, pin, walkFiles(extracted));
    replaceTree(extracted, target);
    console.log(`Installed ${appId} ${pin.version} at ${target}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
const arch = normalizeArch(options.arch);
const pin = loadPin(options.appId, arch);
validatePin(options.appId, pin);
if (options.printLauncher) {
  process.stdout.write(`${launcherPath(managedAppRoot(), options.appId, pin.launchPath)}\n`);
} else {
  await install(options.appId, arch);
}
