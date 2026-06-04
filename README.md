# Feishu Share

An Obsidian plugin for sharing Markdown notes to Feishu docx and syncing them with Feishu docx and Bitable.

## What works

- Share Markdown notes to Feishu docx
- Sync with Feishu docx, Bitable, or both
- Pull Feishu docx content back into local Markdown
- Track sync baselines, conflicts, remote drift, and Bitable record mappings
- Upload local images and attachments
- Process callouts and sub-documents
- Run scheduled smart sync in non-interactive mode
- Read Bitable tables and fields to assist with config

## OAuth callback

The repo includes a self-hostable callback page at `oauth-callback/index.html`.

Use it like this:

1. Deploy the page to any static host.
2. Fill the deployed URL into the plugin's `OAuth回调地址`.
3. Register the same URL in your Feishu app's redirect settings.

More details are in `oauth-callback/README.md`.

## Development

```bash
npm install
npm run build
npm test
```

## CI and release helpers

- GitHub Actions CI lives at `.github/workflows/ci.yml`
- `versions.json` keeps Obsidian compatibility metadata
- `npm run version` syncs `manifest.json` and `versions.json` from `package.json`

## Current limitations

- The plugin now prefers Feishu's structured `Markdown -> docx blocks` pipeline and falls back to the older import-task flow when the tenant token has not been re-authorized with `docx:document.block:convert` yet.
- Feishu OpenAPI can round-trip docx, files, callouts, and most Markdown structure well, but native Mermaid block creation is still constrained by the public docx block APIs.
- Bitable complex fields are safer than before, but user/relation/attachment style fields still depend on the table schema and Feishu-side expectations.
