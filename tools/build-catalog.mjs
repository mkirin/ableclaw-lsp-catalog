#!/usr/bin/env node
/**
 * build-catalog.mjs — regenerate ../catalog.json from current upstream versions.
 *
 *   - eclipse.jdt.ls: scrape the snapshots dir listing, pick the newest
 *     tarball, fetch its sibling `.sha256` (no artifact download required)
 *   - spring-tools: read the latest GitHub Release matching
 *     `vscode-spring-boot-*.vsix`, take `assets.digest` (already sha256)
 *
 * Run locally:
 *   node tools/build-catalog.mjs > ../catalog.json
 *
 * Or via CI: see ../.github/workflows/refresh.yml (which commits the diff
 * back to main when upstreams move).
 *
 * No npm deps — uses Node 20 built-ins (fetch, fs/promises). Exits non-zero
 * on any network/parse error so CI fails loud.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, "..", "catalog.json");

const JDT_SNAPSHOTS = "https://download.eclipse.org/jdtls/snapshots/";
const SPRING_RELEASES_API = "https://api.github.com/repos/spring-projects/spring-tools/releases";

const CATALOG_SOURCE = "https://github.com/mkirin/ableclaw-lsp-catalog";

// ── Helpers ────────────────────────────────────────────────────────────────

async function getText(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}
async function getJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
}
async function headSize(url) {
  // Eclipse mirror redirects; follow once.
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) throw new Error(`HEAD ${url} → HTTP ${res.status}`);
  const len = res.headers.get("content-length");
  if (!len) throw new Error(`HEAD ${url} — no Content-Length`);
  return parseInt(len, 10);
}

// ── JDT.LS resolver ────────────────────────────────────────────────────────

async function resolveJdtLs() {
  // The directory listing is plain HTML — parse out .tar.gz entries.
  const html = await getText(JDT_SNAPSHOTS);
  const matches = [...html.matchAll(/jdt-language-server-(\d+\.\d+\.\d+)-(\d+)\.tar\.gz(?!\.sha)/g)];
  if (matches.length === 0) throw new Error("No JDT.LS snapshots found");
  // Sort by timestamp descending — picks the freshest.
  matches.sort((a, b) => b[2].localeCompare(a[2]));
  const [, semver, ts] = matches[0];
  const fileName = `jdt-language-server-${semver}-${ts}.tar.gz`;
  const downloadUrl = JDT_SNAPSHOTS + fileName;

  const sha = (await getText(downloadUrl + ".sha256")).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    throw new Error(`JDT.LS sha256 sidecar malformed: ${sha.slice(0, 40)}…`);
  }
  const sizeBytes = await headSize(downloadUrl);

  return {
    id: "jdt.ls",
    name: "eclipse.jdt.ls",
    version: `${semver}-${ts}`,
    sizeBytes,
    downloadUrl,
    sha256: sha.toLowerCase(),
    unpack: "tar.gz",
    launcher: {
      command: "${java}",
      args: [
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Dlog.level=ALL",
        "-Xmx1G",
        "--add-modules=ALL-SYSTEM",
        "--add-opens",
        "java.base/java.util=ALL-UNNAMED",
        "--add-opens",
        "java.base/java.lang=ALL-UNNAMED",
        "-jar",
        "${componentDir}/plugins/org.eclipse.equinox.launcher_*.jar",
        "-configuration",
        "${componentDir}/config_${platform}",
        "-data",
        "${dataDir}/jdt.ls",
      ],
    },
  };
}

// ── Spring Boot LS resolver ────────────────────────────────────────────────

async function resolveSpringBootLs() {
  const headers = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};
  const releases = await getJson(`${SPRING_RELEASES_API}?per_page=30`, { headers });
  if (!Array.isArray(releases)) throw new Error("Spring releases API did not return an array");

  for (const rel of releases) {
    const vsix = rel.assets?.find((a) =>
      typeof a.name === "string" &&
      a.name.startsWith("vscode-spring-boot-") &&
      a.name.endsWith(".vsix"),
    );
    if (!vsix) continue;
    const digest = vsix.digest;
    if (!digest || !digest.startsWith("sha256:")) {
      throw new Error(`Spring asset ${vsix.name} has no sha256 digest`);
    }
    const sha = digest.slice("sha256:".length).toLowerCase();
    return {
      id: "spring-boot-ls",
      name: "spring-boot-language-server (vsix)",
      version: rel.tag_name.replace(/^vscode-spring-boot-/, ""),
      sizeBytes: vsix.size,
      downloadUrl: vsix.browser_download_url,
      sha256: sha,
      unpack: "zip",
      launcher: {
        command: "${java}",
        args: [
          "-Xmx768M",
          "-jar",
          "${componentDir}/extension/jars/spring-boot-language-server-*.jar",
        ],
      },
    };
  }
  throw new Error("No vscode-spring-boot release found in the latest 30 releases");
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const [jdt, spring] = await Promise.all([resolveJdtLs(), resolveSpringBootLs()]);

  const totalSize = jdt.sizeBytes + spring.sizeBytes;
  const today = new Date().toISOString().slice(0, 10);

  const catalog = {
    schemaVersion: 1,
    source: CATALOG_SOURCE,
    publishedAt: new Date().toISOString(),
    extensions: [
      {
        id: "java-spring",
        name: "Java + Spring Boot",
        publisher: "eclipse · spring-projects",
        version: "0.43.0", // catalog-side version — bump manually on schema or launcher changes
        description:
          "Eclipse JDT Language Server with Spring Boot language extension. Adds IntelliSense, Go-to-Definition, refactoring, diagnostics, and Spring-specific features (application.yml autocomplete, @RequestMapping hints, bean references) for .java, application.properties, application.yml, pom.xml, and build.gradle.",
        tags: ["Java", "Spring Boot", "Maven", "Gradle", ".properties · .yml"],
        fileTypes: [".java", "application.properties", "application.yml", "pom.xml", "build.gradle"],
        languages: ["java", "spring-boot-properties", "spring-boot-properties-yaml"],
        sizeBytes: totalSize,
        released: today,
        changelogUrl: "https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases",
        requirements: { java: { min: "17" } },
        components: [jdt, spring],
      },
    ],
  };

  const json = JSON.stringify(catalog, null, 2) + "\n";
  await writeFile(OUT_PATH, json, "utf-8");
  process.stderr.write(`✓ Wrote ${OUT_PATH}\n`);
  process.stderr.write(`  jdt.ls         ${jdt.version}  ${(jdt.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${jdt.sha256.slice(0, 12)}…\n`);
  process.stderr.write(`  spring-boot-ls ${spring.version}  ${(spring.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${spring.sha256.slice(0, 12)}…\n`);
}

main().catch((err) => {
  process.stderr.write(`✗ build-catalog failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
