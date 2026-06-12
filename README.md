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

For this repo's current GitHub remote, a push to `main` now auto-deploys `oauth-callback` to GitHub Pages at:

`https://xujinhuan675-cloud.github.io/feishu-share/`

## IOTO Task Profile

The plugin supports profile-based Bitable sync so different Feishu Bases can use different schemas without changing the legacy docx/Bitable flow.

Built-in profile target:

- Base URL: `https://ccnainrpixz2.feishu.cn/base/Wl3rbgORca63instiTpcaz1DnvZ?table=tbl02ZXD0Kkb2xOB&view=vewx3UsjHG`
- `appToken`: `Wl3rbgORca63instiTpcaz1DnvZ`
- `tableId`: `tbl02ZXD0Kkb2xOB`
- `viewId`: `vewx3UsjHG`
- Default target directory: `IOTO/Tasks`

These identifiers belong to the IOTO Task Profile only. They are intentionally separate from the legacy document/default Bitable sync settings:

| Sync area | Config keys | Purpose |
| --- | --- | --- |
| Feishu docx sync | `docToken`, `url`, `targetType`, Drive/Wiki defaults | Markdown document upload and docx round-trip sync |
| Legacy default Bitable sync | `bitableAppToken`, `bitableTableId`, `bitableFieldMapping` | Existing single-schema Bitable mapping used by the old Bitable/both target |
| IOTO Task Profile | `bitableProfiles[].appToken`, `bitableProfiles[].tableId`, `bitableProfiles[].viewId` | Sync the Feishu Base `✅ 任务` table into IOTO Markdown task files |

For the IOTO Task Profile, read the IDs from the Base URL like this:

```text
https://ccnainrpixz2.feishu.cn/base/Wl3rbgORca63instiTpcaz1DnvZ?table=tbl02ZXD0Kkb2xOB&view=vewx3UsjHG
                                      ^ appToken             ^ tableId              ^ viewId
```

Example `Profiles JSON`:

```json
[
  {
    "id": "ioto-task",
    "name": "IOTO Task Profile",
    "enabled": true,
    "appToken": "Wl3rbgORca63instiTpcaz1DnvZ",
    "tableId": "tbl02ZXD0Kkb2xOB",
    "viewId": "vewx3UsjHG",
    "targetDir": "IOTO/Tasks",
    "fileNameTemplate": "{{title}}",
    "fieldMapping": {
      "title": ["任务", "Title", "title"],
      "body": ["正文", "说明", "content"],
      "stage": ["阶段", "Stage", "stage"],
      "status": ["状态", "Status", "status"],
      "ai_scope": ["AI Scope", "ai_scope"],
      "owner": ["负责人", "Owner", "owner"],
      "project": ["项目", "Project", "project"],
      "source": ["来源", "Source", "source"],
      "related": ["关联", "Related", "related"],
      "next_action": ["下一步", "Next Action", "next_action"],
      "review_required": ["需复核", "Review Required", "review_required"],
      "priority": ["优先级", "Priority", "priority"],
      "category": ["分类", "Category", "category"]
    },
    "statusMapping": {
      "未开始": "todo",
      "进行中": "doing",
      "已完成": "done",
      "已取消": "cancelled"
    },
    "reverseStatusMapping": {
      "todo": "未开始",
      "doing": "进行中",
      "done": "已完成",
      "cancelled": "已取消"
    },
    "frontmatterFields": [
      "stage",
      "status",
      "ai_scope",
      "owner",
      "project",
      "source",
      "related",
      "next_action",
      "review_required",
      "feishu_record_id",
      "feishu_table_id",
      "feishu_view_id",
      "feishu_status",
      "feishu_priority",
      "feishu_category",
      "feishu_synced_at"
    ],
    "bodyFields": ["body"],
    "primaryBodyField": "body",
    "bodyTemplate": "{{body}}",
    "syncUncontrolledBody": false
  }
]
```

Each Feishu `record_id` maps to one Markdown file. Profile sync writes Feishu body fields into a managed block:

```md
<!-- feishu-share:bitable-profile:ioto-task:begin -->
Managed content from Feishu.
<!-- feishu-share:bitable-profile:ioto-task:end -->
```

Only mapped frontmatter and the managed block are written back to Feishu by default; notes outside the block are preserved locally and excluded from profile conflict hashes. Set `syncUncontrolledBody: true` only if the whole Markdown body should be eligible for writeback when the managed block is missing.

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
