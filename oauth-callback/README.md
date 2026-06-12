# OAuth Callback Page

This folder contains a static callback page for Feishu OAuth.

## How to use

1. Deploy `index.html` to any static host.
2. Put the deployed URL into the plugin's `OAuth回调地址` setting.
3. Register the same URL in your Feishu app configuration.

## GitHub Pages for this repo

This repo includes `.github/workflows/pages.yml`, which deploys the `oauth-callback` folder to GitHub Pages on every push to `main`.

For the current remote repository `xujinhuan675-cloud/feishu-share`, the callback page URL will be:

`https://xujinhuan675-cloud.github.io/feishu-share/`

After the first successful deploy:

1. Put `https://xujinhuan675-cloud.github.io/feishu-share/` into the plugin's `OAuth回调地址`.
2. Put the same URL into your Feishu app's redirect URI list.
3. Use the plugin's one-click auth flow as usual.

### Troubleshooting First Deploy

If you see:
```
Error: Get Pages site failed. Please verify that the repository has Pages enabled and configured to build using GitHub Actions
```

Try these steps:

1. Go to your GitHub repo -> **Settings** -> **Pages** (left sidebar)
2. Under **Build and deployment**, set **Source** to **GitHub Actions**
3. Click **Save**
4. Re-run the workflow (go to **Actions** -> select the workflow -> **Re-run all jobs**)

Once Pages is enabled once, subsequent pushes will auto-deploy without manual steps.

## Suggested hosts

- GitHub Pages
- Vercel
- Netlify
- Any Nginx or static file server

## What it does

- Receives Feishu `code` / `state` query params
- Redirects to `obsidian://feishu-auth?...`
- Provides a manual fallback button and copy-current-URL button
