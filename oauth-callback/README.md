# OAuth Callback Page

This folder contains a static callback page for Feishu OAuth.

## How to use

1. Deploy `index.html` to any static host.
2. Put the deployed URL into the plugin's `OAuth回调地址` setting.
3. Register the same URL in your Feishu app configuration.

## Suggested hosts

- GitHub Pages
- Vercel
- Netlify
- Any Nginx or static file server

## What it does

- Receives Feishu `code` / `state` query params
- Redirects to `obsidian://feishu-auth?...`
- Provides a manual fallback button and copy-current-URL button
