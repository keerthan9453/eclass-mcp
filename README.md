# eclass-mcp

A **read-only** [MCP](https://modelcontextprotocol.io) server for York University's eClass (Moodle). Ask Claude (or any MCP client) things like *"what's due this week?"* or *"what's my grade in EECS 2311?"*

> Unofficial; not affiliated with York University. Your own account only. Check York's acceptable-use policy.

## Try it in 10 seconds (no login needed)

```bash
npx -y github:keerthan9453/eclass-mcp --demo
```
Runs against a built-in fake eClass. To see every tool called, clone the repo and run `npm install && npm run demo`.

## Use it with your account

Pick whichever setup York allows. They can be combined.

| Setup | What you get | Needs |
|---|---|---|
| **A. Calendar feed** (easiest) | `get_upcoming_deadlines` | Your private ICS URL |
| **B. Web service token** | courses, assignments, grades, course contents | A Moodle token (York must allow it) |

### A. Calendar feed
In eClass: **Calendar → Import or export calendars → Export** → pick "All courses" + a time range → *Get calendar URL*. Copy it.

### B. Web service token
Try `https://eclass.yorku.ca/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1&urlscheme=moodlemobile` while signed in. If York allows the mobile service, the browser tries to open a `moodlemobile://token=…` link containing base64 data of the form `siteid:::token`. The part after `:::` is your token. If it's blocked, use setup A only. `check_connection` tells you whether a token works.

### Claude Desktop / any MCP client config
```json
{
  "mcpServers": {
    "eclass": {
      "command": "npx",
      "args": ["-y", "github:keerthan9453/eclass-mcp"],
      "env": {
        "ECLASS_ICS_URL": "https://eclass.yorku.ca/calendar/export_execute.php?...",
        "ECLASS_WS_TOKEN": "optional-token"
      }
    }
  }
}
```
Claude Code: `claude mcp add eclass -e ECLASS_ICS_URL=... -- npx -y github:keerthan9453/eclass-mcp`

## Tools
| Tool | Needs | Description |
|---|---|---|
| `get_upcoming_deadlines(days)` | token or ICS | Deadlines in the next N days (1–365, default 14). Uses the token if set, else the calendar feed |
| `check_connection` | token | Confirms the token works; shows your name |
| `list_courses` | token | Enrolled courses with ids |
| `get_assignments(course_id)` | token | Assignments and due dates |
| `get_grades(course_id)` | token | Your grade items |
| `get_course_contents(course_id)` | token | Sections, resources, activities |

## Environment variables
`ECLASS_ICS_URL`, `ECLASS_WS_TOKEN`, `ECLASS_BASE_URL` (default `https://eclass.yorku.ca`), `ECLASS_TIMEOUT_MS` (default 15000), `ECLASS_TRANSPORT` (`curl` default, or `fetch`).

## Scenarios handled
- No config → only the calendar tool shows, with an error saying what to set
- Calendar URL expired/regenerated (404), or returns a login page → explicit error
- Token invalid, or web services disabled → explicit error; secrets are never echoed back
- Slow or unreachable server → times out (no hang)
- `http://` to a non-local host → refused so credentials aren't sent in clear text
- Course with no assignments/grades, assignments with no due date → handled
- Schulich courses live on Canvas, not eClass, so they won't appear

## Firewall note
York's front end may answer Node's built-in `fetch` with an HTML bot-challenge page (HTTP 202) while accepting `curl`. The server therefore sends requests through your system `curl` by default (needs `curl` on PATH, which macOS and most Linux have). Set `ECLASS_TRANSPORT=fetch` to force Node's fetch.

## Security
The ICS URL and token grant access to your account. Keep them in your MCP client's `env`, never commit them. The server never writes to eClass.

## Development
```bash
npm install
npm test     # builds and runs 22 end-to-end scenarios against a mock eClass
npm run demo # scripted walkthrough
```
`dist/` is committed so `npx github:...` works without a build step. Run `npm run build` before committing source changes.
