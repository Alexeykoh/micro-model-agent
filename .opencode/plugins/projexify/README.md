# projexify OpenCode plugin

One tool (`projexify_api`) wraps all 24 endpoints of the projexify External API, so the
model pays for a single tool schema instead of 24.

## Setup

The plugin is auto-discovered from `.opencode/plugins/`. No config edit needed.

- Base URL: `http://localhost:80/api/v1/external` by default. Override with
  `PROJEXIFY_BASE_URL` (a bare origin or the full `/api/v1/external` path both work).
- Token: put the `pxt_...` token in `token.txt` next to this file (gitignored),
  or set `PROJEXIFY_TOKEN`. Env wins over the file.

If configured explicitly in `opencode.json(c)`, `options.token` and
`options.baseURL` take precedence over env/file:

```jsonc
{
  "plugins": [
    {
      "package": "./.opencode/plugins/projexify",
      "options": {
        "baseURL": "http://localhost:80",
        "token": "{file:~/.secrets/projexify-token}"
      }
    }
  ]
}
```

> Don't put the raw token in `index.ts`, `README.md` or any tracked file.

## Calling

In Code Mode: `await tools.projexify_api({ action: "projects.list" })`.
In a regular session the tool appears as `projexify_api` with the same input.

Every call needs `action`. All actions except `projects.list` need `projectId`;
task actions also need `taskId`. `targetId` carries `userId` (assign/unassign),
`itemId` (checklist) or `linkId` (links.delete). Write fields and list filters
go in `params`. The full action list is in the tool description.

Examples:

```ts
await tools.projexify_api({ action: "projects.list" });
await tools.projexify_api({ action: "tasks.list", projectId: "p1", params: { priority: "HIGH", limit: 10 } });
await tools.projexify_api({ action: "tasks.create", projectId: "p1", params: { title: "Новая задача", priority: "HIGH" } });
await tools.projexify_api({ action: "tasks.setStatus", projectId: "p1", taskId: "t1", params: { statusId: "s2" } });
await tools.projexify_api({ action: "comments.add", projectId: "p1", taskId: "t1", params: { content: "В работе" } });
```

The token is stripped from any response text; output is capped at 12K chars.
HTTP errors 400/401/403/404/409 get a short Russian hint for the model.

Tests: `bun test tests/plugins/projexify.test.ts`.
