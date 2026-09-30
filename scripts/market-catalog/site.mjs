#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

export const CATALOG_PATH = "market/v1/catalog.json";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortDigest(digest) {
  return typeof digest === "string" && digest.length > 19 ? `${digest.slice(0, 19)}…` : digest || "—";
}

function renderTagRow(tag) {
  const platforms = tag.platforms
    .map((platform) => `${platform.os}/${platform.architecture}`)
    .join(", ") || "—";
  return `        <tr>
          <td><code>${escapeHtml(tag.name)}</code></td>
          <td>${tag.version ? escapeHtml(tag.version) : "—"}</td>
          <td title="${escapeHtml(tag.manifestDigest || "")}"><code>${escapeHtml(shortDigest(tag.manifestDigest))}</code></td>
          <td>${platforms === "—" ? "—" : escapeHtml(platforms)}</td>
          <td>${tag.publishedAt ? escapeHtml(tag.publishedAt) : "—"}</td>
        </tr>`;
}

function renderImage(entry) {
  const { image, path: imagePath } = entry;
  const tags = image.tags.map(renderTagRow).join("\n");
  const capabilities = image.capabilities.map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`).join("");
  return `    <article class="card">
      <header>
        <h2>${escapeHtml(image.name)}</h2>
        <code class="slug">${escapeHtml(image.slug)}</code>
      </header>
      <p>${escapeHtml(image.description)}</p>
      <p class="caps">${capabilities}</p>
      <table>
        <thead><tr><th>tag</th><th>version</th><th>manifest digest</th><th>platforms</th><th>published</th></tr></thead>
        <tbody>
${tags}
        </tbody>
      </table>
      <p class="links"><a href="${escapeHtml(imagePath)}">${escapeHtml(imagePath)}</a></p>
    </article>`;
}

export function renderIndexHtml(input) {
  const { catalog, domain } = input;
  const images = input.images.map(renderImage).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TaskHandoff Images</title>
  <style>
    :root { color-scheme: light dark; --border: color-mix(in srgb, currentColor 16%, transparent); --muted: color-mix(in srgb, currentColor 62%, transparent); }
    * { box-sizing: border-box; }
    body { margin: 0 auto; max-width: 960px; padding: 3rem 1.25rem 4rem; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    h1 { font-size: 1.6rem; margin: 0 0 .35rem; }
    .meta { color: var(--muted); margin: 0 0 2rem; }
    .meta code { color: inherit; }
    .card { border: 1px solid var(--border); border-radius: 12px; padding: 1.1rem 1.25rem; margin-bottom: 1.25rem; }
    .card header { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
    .card h2 { font-size: 1.05rem; margin: 0; }
    .slug { color: var(--muted); }
    .chip { border: 1px solid var(--border); border-radius: 999px; padding: .05rem .55rem; margin-right: .35rem; font-size: .82rem; }
    .caps { margin: .5rem 0 .9rem; }
    table { width: 100%; border-collapse: collapse; font-size: .88rem; }
    th, td { text-align: left; padding: .3rem .5rem .3rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 500; }
    code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; }
    .links { margin: .7rem 0 0; font-size: .88rem; }
  </style>
</head>
<body>
  <h1>TaskHandoff Images</h1>
  <p class="meta">Market catalog for <code>${escapeHtml(domain)}</code> · <a href="${escapeHtml(CATALOG_PATH)}">${escapeHtml(CATALOG_PATH)}</a> · revision <code>${escapeHtml(catalog.revision)}</code> · generated ${escapeHtml(catalog.generatedAt)} · protocol ${escapeHtml(catalog.protocolVersion)}</p>
${images}
</body>
</html>
`;
}

export function writeCatalogSite(input) {
  const outDir = path.resolve(input.outDir);
  const catalogBytes = input.catalogBytes;
  const catalogPath = path.join(outDir, CATALOG_PATH);
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, catalogBytes, "utf8");
  if (input.signature) fs.writeFileSync(path.join(outDir, "market", "v1", "catalog.sig"), input.signature, "utf8");

  const imagesDir = path.join(outDir, "market", "v1", "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const images = input.catalog.items.map((image) => {
    const imagePath = `market/v1/images/${image.slug}.json`;
    fs.writeFileSync(path.join(outDir, imagePath), `${JSON.stringify(image, null, 2)}\n`, "utf8");
    return { image, path: imagePath };
  });
  fs.writeFileSync(path.join(outDir, "market", "v1", "index.json"), `${JSON.stringify({
    protocolVersion: input.catalog.protocolVersion,
    revision: input.catalog.revision,
    generatedAt: input.catalog.generatedAt,
    items: images.map(({ image, path: imagePath }) => ({ id: image.id, slug: image.slug, path: imagePath })),
  }, null, 2)}\n`, "utf8");

  fs.writeFileSync(path.join(outDir, "index.html"), renderIndexHtml({ catalog: input.catalog, images, domain: input.domain }), "utf8");
  fs.writeFileSync(path.join(outDir, "CNAME"), `${input.domain}\n`, "utf8");
  fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");
  return { catalogPath, images };
}
