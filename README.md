# ableclaw-lsp-catalog

Remote manifest consumed by ableclaw Desktop → Settings → **Language Support**.
Each entry describes one installable LSP extension (download URLs, SHA-256
checksums, launcher invocation, system requirements).

Desktop clients fetch `catalog.json` from `raw.githubusercontent.com` with a
10-minute cache; the schema is defined in
[`@ableclaw/types/lsp-catalog`](https://github.com/mkirin/ableclaw/blob/main/packages/types/src/lsp-catalog.ts).

## Layout

```
catalog.json                ← the published manifest (consumed by Desktop)
tools/
  build-catalog.mjs         ← node script that refreshes catalog.json from upstream
.github/workflows/
  refresh.yml               ← daily cron that runs build-catalog and opens a PR
```

## How catalog.json gets updated

Two paths:

1. **Manual** — bump versions or add a new extension:
   ```bash
   node tools/build-catalog.mjs   # rewrites catalog.json in place
   git diff catalog.json          # review the bump
   git commit -am "catalog: bump jdt.ls / spring-boot-ls"
   git push
   ```

2. **Automatic** — the `refresh.yml` workflow runs daily, regenerates
   `catalog.json`, and opens a PR if it changed. Merge to publish.

Both rely on the same `tools/build-catalog.mjs`. It:

- Scrapes `download.eclipse.org/jdtls/snapshots/` for the newest
  `jdt-language-server-*.tar.gz`; pulls the SHA from the sibling `.sha256`.
- Reads `spring-projects/spring-tools` GitHub Releases via the API; picks
  the latest `vscode-spring-boot-*.vsix` and uses `assets.digest`.
- Writes the result to `catalog.json` with a fresh `publishedAt`.

No npm deps — Node 20 built-ins only. `GITHUB_TOKEN` recommended for the
Spring API lookup (unauthenticated requests are rate-limited to 60/hr).

## Schema versions

The top-level `schemaVersion` is **1**. Desktop clients silently drop
extensions with a higher schemaVersion than they understand, so we can
roll out new features by bumping the number and keeping a v1 entry alongside
the v2 entry until the desktop migration ships.

Breaking changes to existing fields (e.g. renaming `launcher.args` →
`launcher.command_args`) **require** a schemaVersion bump.

## Adding a new extension

Edit `tools/build-catalog.mjs` and add a resolver:

```js
async function resolvePythonLsp() {
  // ... fetch upstream version + sha + size ...
  return {
    id: "pylsp",
    name: "python-lsp-server",
    version: "...",
    sizeBytes: ...,
    downloadUrl: "...",
    sha256: "...",
    unpack: "tar.gz" | "zip" | "none",
    launcher: { command: "${python}", args: [...] },
  };
}
```

Then add an extension entry in `main()` that bundles the new component(s).
Push and the next refresh cycle picks it up.

## Beta / unstable releases

Mark them with a `prerelease: true` field at the extension level (not yet
in the schema — proposed). Desktop will gate them behind a "Show
prereleases" toggle in the Language Support page.

## Trust model

- All download URLs **must** be HTTPS and on a domain controlled by the
  upstream project (eclipse.org, github.com/spring-projects, etc.).
- The SHA-256 in this catalog is the **source of truth** — Desktop refuses
  to install if the downloaded artifact's hash doesn't match.
- If an upstream rewrites a published artifact in place (rare but it
  happens with snapshots), regenerate the catalog and push.

## License

CC0 / public domain — this manifest is metadata about other projects.
