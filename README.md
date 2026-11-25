# eclass-mcp

A **read-only** [MCP](https://modelcontextprotocol.io) server for York University's eClass (Moodle). Ask Claude (or any MCP client) things like *"what's due this week?"* or *"what's my grade in EECS 2311?"*

> Unofficial; not affiliated with York University. Your own account only. Check York's acceptable-use policy.

## Try it in 10 seconds (no login needed)


### Web service token ( Preffered and Automated )

**Easiest (macOS): one command, no DevTools**
```bash
npx -y github:keerthan9453/eclass-mcp setup
```
Your browser opens eClass: sign in, then press Return in Terminal. Setup then opens the token link in the same browser (it also prints the link so you can paste it yourself); when the browser asks to open **"eClass MCP Login"**, click **Open**. Setup checks the token, adds the `eclass` server to your Claude Desktop config (keeping your other servers and saving a `.bak` backup), and removes its helper. The token is never shown. Then quit Claude (Cmd+Q) and reopen it.

Setup opens eClass in Chrome, Brave, Firefox, Edge, Arc, Vivaldi or Opera (whichever it finds first), even if Safari is your default: Safari won't hand the link to the helper. If you only have Safari, install one of those or use the manual steps.

Options: `--browser chrome|brave|firefox|edge|arc|vivaldi|opera|safari`, `--site https://your.moodle.site`, `--config /path/to/config.json`.

**Manual steps** (Windows/Linux, or if the setup command doesn't work):

Gets you courses, assignments, grades, course contents and deadlines. It works only if your school allows Moodle's mobile service (York does). Use **Chrome, Brave or Edge**: Safari doesn't show the request you need.

1. Sign in to eClass in Chrome. Open DevTools (Cmd+Option+I, or F12) → **Network**, and tick **Preserve log**.
2. In the same tab, open:
   `https://eclass.yorku.ca/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=12345&urlscheme=moodlemobile`
   The page appears to fail ("Unsupported URL scheme" or "invalid address"). That means it worked: eClass redirected to a `moodlemobile://token=…` link, which only the Moodle mobile app can open.
3. In the Network list, find the request whose name starts with `moodlemobile://token=`. Right-click it → **Copy → Copy URL**. (If it isn't listed, click the `launch.php` row and read the `Location` header.)
4. Turn that link into your token. Run this in Terminal, paste the link when asked (nothing shows as you paste), and press Return:
   ```bash
   printf 'Paste link: '; read -rs L; echo; node -e "console.log(Buffer.from(process.argv[1].trim().split('token=').pop(),'base64').toString().split(':::')[1])" "$L"
   ```
   It prints a 32-character string. That is your `ECLASS_WS_TOKEN`.
5. Put it in your MCP client config (below). Don't paste it into chat, issues or commits.

**It didn't work?**
- *A Moodle error page ("Web service is not available")* means your school has the mobile service off. Use setup A.
- *Nothing in the Network list* means the page was opened before DevTools. Reload it with DevTools open and Preserve log on.
- Safari reports "address is invalid" and shows no request, so switch to Chrome.
- If `check_connection` later returns an HTML page with HTTP 202, a firewall is challenging the request. The server already uses your system `curl` to avoid this (see *Firewall note*).

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
| `list_course_files(course_id, name_contains?)` | token | Files in a course (PDFs, slides, docs) with a `file_url` |
| `outline_course_file(file_url)` | token | Page count, size and heading of each page (cheap first look) |
| `search_course_file(file_url, query, context_lines?, max_results?)` | token | Only the lines matching `query` (use `\|` for alternatives), with page numbers |
| `read_course_file(file_url, pages?, max_chars?)` | token | Full text of a PDF or text file, capped at 6,000 chars by default. PDFs need a text layer (no OCR); `.pptx`/`.docx` not yet supported |

## Environment variables
`ECLASS_ICS_URL`, `ECLASS_WS_TOKEN`, `ECLASS_BASE_URL` (default `https://eclass.yorku.ca`), `ECLASS_TIMEOUT_MS` (default 15000), `ECLASS_TRANSPORT` (`curl` default, or `fetch`), `ECLASS_MAX_FILE_MB` (default 25).

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

## Course files
`read_course_file` downloads the file to a temporary folder, extracts the text, and deletes the copy. The token is only ever sent to your eClass site's own file endpoint; any other URL is refused. Course materials are your instructors' work: read them for your own study, don't redistribute them.

**Keeping token usage down:** search first, outline second, read last. Repeated page headers/footers and extra whitespace are removed before anything is returned.

## Security
The ICS URL and token grant access to your account. Keep them in your MCP client's `env`, never commit them. The server never writes to eClass.

## Development
```bash
npm install
npm test     # builds and runs 46 end-to-end scenarios against a mock eClass
npm run demo # scripted walkthrough
```
`dist/` is committed so `npx github:...` works without a build step. Run `npm run build` before committing source changes.
