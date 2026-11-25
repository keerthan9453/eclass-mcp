#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ical from "node-ical";
// `--demo`: run against a built-in fake eClass so you can try the tools without any credentials.
if (process.argv.includes("--demo")) {
    const { startMock, GOOD_TOKEN } = await import("../demo/mock-eclass.mjs");
    const { base } = await startMock();
    process.env.ECLASS_BASE_URL = base;
    process.env.ECLASS_WS_TOKEN = GOOD_TOKEN;
    process.env.ECLASS_ICS_URL = `${base}/calendar/export_execute.php?authtoken=ok`;
    console.error(`[demo] fake eClass at ${base}`);
}
// ---- Config (environment variables) ----
// ECLASS_BASE_URL   e.g. https://eclass.yorku.ca
// ECLASS_ICS_URL    private calendar export URL (Calendar > Import or export calendars)
// ECLASS_WS_TOKEN   Moodle web service token (optional, enables API tools)
const BASE = (process.env.ECLASS_BASE_URL ?? "https://eclass.yorku.ca").replace(/\/$/, "");
const ICS_URL = process.env.ECLASS_ICS_URL;
const TOKEN = process.env.ECLASS_WS_TOKEN;
const TIMEOUT_MS = Number(process.env.ECLASS_TIMEOUT_MS ?? 15000);
function isLocal(u) {
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}
function assertSafeUrl(raw, label) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        throw new Error(`${label} is not a valid URL.`);
    }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u)))
        throw new Error(`${label} must use https (credentials would be sent in clear text).`);
    return u;
}
// Never leak secrets in error text
const scrub = (m) => {
    let out = m;
    for (const secret of [TOKEN, ICS_URL])
        if (secret && secret.length >= 8)
            out = out.split(secret).join("[redacted]");
    return out;
};
const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });
// ---- HTTP transport ----
// York's front-end firewall challenges Node's built-in fetch but accepts curl, so by default
// requests go through the system `curl` binary (falls back to fetch if curl is missing).
// Secrets (token, ICS URL) are passed on stdin, never on the command line.
const UA = "eclass-mcp/0.1 (+https://github.com/keerthan9453/eclass-mcp)";
function curlRequest(url, body) {
    return new Promise((resolve, reject) => {
        const cfg = (k, v) => `${k} = "${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
        const args = ["-sS", "-L", "--max-time", String(TIMEOUT_MS / 1000), "-K", "-",
            "-w", "\n%{http_code}\t%{content_type}\t%{url_effective}"];
        // URL and body go via the config on stdin so they never appear in `ps`
        let input = cfg("url", url); // curl keeps its own default User-Agent
        if (body !== undefined)
            input += cfg("request", "POST") + cfg("data", body) + cfg("header", "content-type: application/x-www-form-urlencoded");
        const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => reject(Object.assign(new Error(e.code === "ENOENT" ? "curl not found" : String(e.message)), { noCurl: e.code === "ENOENT" })));
        child.on("close", (code) => {
            if (code !== 0)
                return reject(new Error(`curl failed (exit ${code}): ${err.trim().split("\n").pop()}`));
            const i = out.lastIndexOf("\n");
            const [status, contentType, finalUrl] = out.slice(i + 1).split("\t");
            resolve({ status: Number(status), contentType: contentType || "unknown", finalUrl: finalUrl || url, text: out.slice(0, i) });
        });
        child.stdin.end(input);
    });
}
async function fetchRequest(url, body) {
    const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        body,
        headers: { "user-agent": UA, ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, contentType: res.headers.get("content-type") ?? "unknown", finalUrl: res.url, text: await res.text() };
}
async function httpRequest(url, body) {
    if ((process.env.ECLASS_TRANSPORT ?? "curl") === "fetch")
        return fetchRequest(url, body);
    try {
        return await curlRequest(url, body);
    }
    catch (e) {
        if (e.noCurl)
            return fetchRequest(url, body);
        throw e;
    }
}
// ---- Moodle web service helper (read-only) ----
async function ws(wsfunction, params = {}) {
    if (!TOKEN)
        throw new Error("ECLASS_WS_TOKEN is not set.");
    assertSafeUrl(BASE, "ECLASS_BASE_URL");
    const form = new URLSearchParams({
        wstoken: TOKEN,
        wsfunction,
        moodlewsrestformat: "json",
        ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    });
    const res = await httpRequest(`${BASE}/webservice/rest/server.php`, form.toString());
    const raw = res.text;
    const snippet = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        const u = new URL(res.finalUrl);
        throw new Error(`eClass did not return JSON (HTTP ${res.status}, ${res.contentType}, ended at ${u.host}${u.pathname}). ` +
            `Likely causes: a login/SSO redirect, a bot-protection challenge, a wrong ECLASS_BASE_URL, or web services disabled. ` +
            `Page text: "${snippet}"`);
    }
    if (!(res.status >= 200 && res.status < 300) && !data?.exception)
        throw new Error(`HTTP ${res.status} from eClass web service`);
    if (data?.exception)
        throw new Error(`${data.errorcode}: ${data.message}`);
    return data;
}
// ---- Binary download (course files) ----
const MAX_FILE_MB = Number(process.env.ECLASS_MAX_FILE_MB ?? 25);
async function curlDownload(url) {
    const dir = await mkdtemp(join(tmpdir(), "eclass-mcp-"));
    const out = join(dir, "file");
    try {
        const cfg = (k, v) => `${k} = "${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
        const meta = await new Promise((resolve, reject) => {
            const child = spawn("curl", ["-sS", "-L", "--max-time", String(Math.max(60, TIMEOUT_MS / 1000)),
                "--max-filesize", String(Math.max(1, Math.floor(MAX_FILE_MB * 1024 * 1024))), "-K", "-", "-w", "%{http_code}\t%{content_type}"]);
            let o = "", e = "";
            child.stdout.on("data", (d) => (o += d));
            child.stderr.on("data", (d) => (e += d));
            child.on("error", (err) => reject(Object.assign(new Error(err.code === "ENOENT" ? "curl not found" : String(err.message)), { noCurl: err.code === "ENOENT" })));
            child.on("close", (code) => code === 0 ? resolve(o)
                : reject(new Error(code === 63 ? `File is larger than ${MAX_FILE_MB} MB (ECLASS_MAX_FILE_MB).` : `curl failed (exit ${code}): ${e.trim().split("\n").pop()}`)));
            child.stdin.end(cfg("url", url) + cfg("output", out));
        });
        const [status, contentType] = meta.split("\t");
        return { status: Number(status), contentType: contentType || "unknown", bytes: await readFile(out) };
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
async function fetchDownload(url) {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(Math.max(60000, TIMEOUT_MS)) });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FILE_MB * 1024 * 1024)
        throw new Error(`File is larger than ${MAX_FILE_MB} MB (ECLASS_MAX_FILE_MB).`);
    return { status: res.status, contentType: res.headers.get("content-type") ?? "unknown", bytes };
}
async function downloadFile(url) {
    if ((process.env.ECLASS_TRANSPORT ?? "curl") === "fetch")
        return fetchDownload(url);
    try {
        return await curlDownload(url);
    }
    catch (e) {
        if (e.noCurl)
            return fetchDownload(url);
        throw e;
    }
}
// Only ever send the token to this eClass site's own file endpoint.
function eclassFileUrl(raw) {
    const base = assertSafeUrl(BASE, "ECLASS_BASE_URL");
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        throw new Error("file_url is not a valid URL. Use a file_url from list_course_files.");
    }
    if (u.origin !== base.origin || !/\/(webservice\/)?pluginfile\.php\//.test(u.pathname))
        throw new Error("file_url must be an eClass file link from list_course_files (refusing to send the token elsewhere).");
    u.pathname = u.pathname.replace(/^(.*?)\/pluginfile\.php\//, (m, pre) => pre.endsWith("/webservice") ? m : `${pre}/webservice/pluginfile.php/`);
    u.searchParams.delete("token");
    u.searchParams.set("token", TOKEN);
    return u;
}
function parsePages(spec, total) {
    if (!spec)
        return Array.from({ length: total }, (_, i) => i + 1);
    const set = new Set();
    for (const part of spec.split(",")) {
        const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!m)
            throw new Error(`Bad pages value "${spec}". Use e.g. "1-3,7".`);
        const a = Number(m[1]), b = Number(m[2] ?? m[1]);
        for (let i = Math.max(1, a); i <= Math.min(total, b); i++)
            set.add(i);
    }
    return [...set].sort((x, y) => x - y);
}
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;
const fmtDate = (d) => new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });
const server = new McpServer({ name: "eclass", version: "0.1.0" });
// ---- ICS tools ----
server.registerTool("get_upcoming_deadlines", {
    description: "List upcoming eClass deadlines (assignments, quizzes). Uses the web service token if set, otherwise the exported ICS calendar feed.",
    inputSchema: { days: z.number().int().min(1).max(365).default(14).describe("How many days ahead to look") },
}, async ({ days }) => {
    if (TOKEN) {
        try {
            const now = Math.floor(Date.now() / 1000);
            const r = await ws("core_calendar_get_action_events_by_timesort", {
                timesortfrom: now, timesortto: now + days * 86400, limitnum: 50,
            });
            const rows = (r.events ?? [])
                .sort((a, b) => a.timesort - b.timesort)
                .map((e) => `${fmtDate(e.timesort * 1000)} — ${e.name}${e.course?.shortname ? ` [${e.course.shortname}]` : ""}`);
            return text(rows.length ? rows.join("\n") : `No events in the next ${days} days.`);
        }
        catch (e) {
            if (!ICS_URL)
                return fail(scrub(String(e.message)));
            // otherwise fall through to the ICS feed
        }
    }
    if (!ICS_URL)
        return fail("Set ECLASS_WS_TOKEN, or ECLASS_ICS_URL (eClass: Calendar > Import or export calendars > Export).");
    try {
        assertSafeUrl(ICS_URL, "ECLASS_ICS_URL");
        const res = await httpRequest(ICS_URL);
        if (!(res.status >= 200 && res.status < 300))
            throw new Error(`HTTP ${res.status} (the export URL may have been regenerated or expired, or blocked by a firewall challenge)`);
        const body = res.text;
        if (!body.includes("BEGIN:VCALENDAR"))
            throw new Error("Response was not an ICS calendar (got a login page?).");
        const events = ical.sync.parseICS(body);
        const now = Date.now();
        const end = now + days * 86400_000;
        const rows = Object.values(events)
            .filter((e) => e.type === "VEVENT" && e.start)
            .map((e) => ({ start: new Date(e.start).getTime(), title: e.summary, course: e.categories?.join(", ") ?? "", desc: e.description }))
            .filter((e) => e.start >= now && e.start <= end)
            .sort((a, b) => a.start - b.start)
            .map((e) => `${fmtDate(e.start)} — ${e.title}${e.course ? ` [${e.course}]` : ""}`);
        return text(rows.length ? rows.join("\n") : `No events in the next ${days} days.`);
    }
    catch (e) {
        return fail(`Failed to read ICS feed: ${scrub(String(e.message))}`);
    }
});
// ---- Web service tools (registered only if a token is configured) ----
if (TOKEN) {
    let userId;
    const getUserId = async () => (userId ??= (await ws("core_webservice_get_site_info")).userid);
    server.registerTool("check_connection", { description: "Verify the eClass web service token works and show the signed-in user.", inputSchema: {} }, async () => {
        try {
            const i = await ws("core_webservice_get_site_info");
            return text(`Connected to ${i.sitename} as ${i.fullname} (id ${i.userid}). Moodle ${i.release}.`);
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
    server.registerTool("list_courses", { description: "List the courses you are enrolled in.", inputSchema: {} }, async () => {
        try {
            const courses = await ws("core_enrol_get_users_courses", { userid: await getUserId() });
            return text(courses.map((c) => `${c.id}: ${c.fullname} (${c.shortname})`).join("\n") || "No courses.");
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
    server.registerTool("get_assignments", {
        description: "List assignments and due dates for a course.",
        inputSchema: { course_id: z.number().int() },
    }, async ({ course_id }) => {
        try {
            const r = await ws("mod_assign_get_assignments", { "courseids[0]": course_id });
            const list = (r.courses?.[0]?.assignments ?? []);
            return text(list
                .map((a) => `${a.name} — due ${a.duedate ? fmtDate(a.duedate * 1000) : "no due date"} (id ${a.id})`)
                .join("\n") || "No assignments.");
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
    server.registerTool("get_grades", {
        description: "Get your grade items for a course.",
        inputSchema: { course_id: z.number().int() },
    }, async ({ course_id }) => {
        try {
            const r = await ws("gradereport_user_get_grade_items", { courseid: course_id, userid: await getUserId() });
            const items = (r.usergrades?.[0]?.gradeitems ?? []);
            return text(items
                .map((g) => `${g.itemname ?? "Course total"}: ${g.gradeformatted ?? "-"} (range ${g.grademin}-${g.grademax})`)
                .join("\n") || "No grades.");
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
    server.registerTool("list_course_files", {
        description: "List the files (PDFs, slides, documents) attached to a course's resources and folders, with a file_url to pass to read_course_file.",
        inputSchema: { course_id: z.number().int(), name_contains: z.string().optional().describe("Only files whose name or activity contains this text (case-insensitive)") },
    }, async ({ course_id, name_contains }) => {
        try {
            const sections = await ws("core_course_get_contents", { courseid: course_id });
            const q = name_contains?.toLowerCase();
            const rows = [];
            for (const s of sections)
                for (const m of s.modules ?? [])
                    for (const f of m.contents ?? []) {
                        if (f.type !== "file" || !f.fileurl)
                            continue;
                        const label = `${s.name} / ${m.name} / ${f.filename}`;
                        if (q && !label.toLowerCase().includes(q))
                            continue;
                        const kb = f.filesize ? ` ${(f.filesize / 1024).toFixed(0)} KB` : "";
                        rows.push(`- ${label} (${f.mimetype ?? "unknown"}${kb})\n  file_url: ${f.fileurl}`);
                    }
            return text(rows.length ? rows.join("\n") : "No downloadable files found" + (q ? ` matching "${name_contains}".` : "."));
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
    server.registerTool("read_course_file", {
        description: "Download an eClass course file and return its text. Supports PDFs (text layer only, no OCR) and plain-text formats. Use pages to read part of a long PDF.",
        inputSchema: {
            file_url: z.string().describe("A file_url from list_course_files"),
            pages: z.string().optional().describe('PDF pages to read, e.g. "1-3,7". Default: all'),
            max_chars: z.number().int().min(500).max(100000).default(20000).describe("Truncate the returned text to this many characters"),
        },
    }, async ({ file_url, pages, max_chars }) => {
        try {
            const url = eclassFileUrl(file_url);
            const res = await downloadFile(url.toString());
            const head = res.bytes.subarray(0, 5).toString("latin1");
            if (res.status < 200 || res.status >= 300)
                throw new Error(`HTTP ${res.status} downloading file`);
            let out;
            if (head === "%PDF-") {
                const { getDocumentProxy, extractText } = await import("unpdf");
                const pdf = await getDocumentProxy(new Uint8Array(res.bytes));
                const { totalPages, text: per } = await extractText(pdf, { mergePages: false });
                const want = parsePages(pages, totalPages);
                const body = want.map((n) => `--- page ${n} ---\n${per[n - 1].trim()}`).join("\n\n");
                if (!body.replace(/--- page \d+ ---/g, "").trim())
                    return text(`PDF has ${totalPages} pages but no text layer (probably scanned images). OCR is not supported.`);
                out = `PDF, ${totalPages} pages (showing ${want.length}).\n\n${body}`;
            }
            else if (TEXT_TYPES.test(res.contentType) || /\.(txt|md|csv|json|xml|html?)$/i.test(url.pathname)) {
                const t = res.bytes.toString("utf8");
                if (/^\s*\{\s*"(error|exception)"/.test(t))
                    throw new Error(JSON.parse(t).error ?? JSON.parse(t).message ?? "eClass refused the file");
                out = res.contentType.includes("html") ? t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/[ \t]+/g, " ") : t;
            }
            else {
                return fail(`Unsupported file type (${res.contentType}). Only PDFs and text files can be read for now.`);
            }
            return text(out.length > max_chars ? out.slice(0, max_chars) + `\n\n[truncated at ${max_chars} of ${out.length} chars; use pages or max_chars]` : out);
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
    server.registerTool("get_course_contents", {
        description: "List the sections and activities/resources in a course.",
        inputSchema: { course_id: z.number().int() },
    }, async ({ course_id }) => {
        try {
            const sections = await ws("core_course_get_contents", { courseid: course_id });
            return text(sections
                .map((s) => `## ${s.name}\n` + (s.modules ?? []).map((m) => `- [${m.modname}] ${m.name}`).join("\n"))
                .join("\n\n"));
        }
        catch (e) {
            return fail(scrub(String(e.message)));
        }
    });
}
await server.connect(new StdioServerTransport());
console.error(`eclass MCP running (ICS: ${ICS_URL ? "on" : "off"}, API: ${TOKEN ? "on" : "off"})`);
// Exit when the client disconnects (otherwise the --demo mock server would keep the process alive).
process.stdin.on("close", () => process.exit(0));
