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
  const { startMock, GOOD_TOKEN } = await import("../demo/mock-eclass.mjs" as string);
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

function isLocal(u: URL) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}
function assertSafeUrl(raw: string, label: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${label} is not a valid URL.`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u)))
    throw new Error(`${label} must use https (credentials would be sent in clear text).`);
  return u;
}
// Never leak secrets in error text
const scrub = (m: string) => {
  let out = m;
  for (const secret of [TOKEN, ICS_URL]) if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out;
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

// ---- HTTP transport ----
// York's front-end firewall challenges Node's built-in fetch but accepts curl, so by default
// requests go through the system `curl` binary (falls back to fetch if curl is missing).
// Secrets (token, ICS URL) are passed on stdin, never on the command line.
const UA = "eclass-mcp/0.1 (+https://github.com/keerthan9453/eclass-mcp)";
type Resp = { status: number; contentType: string; finalUrl: string; text: string };

function curlRequest(url: string, body?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const cfg = (k: string, v: string) => `${k} = "${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    const args = ["-sS", "-L", "--max-time", String(TIMEOUT_MS / 1000), "-K", "-",
      "-w", "\n%{http_code}\t%{content_type}\t%{url_effective}"];
    // URL and body go via the config on stdin so they never appear in `ps`
    let input = cfg("url", url); // curl keeps its own default User-Agent
    if (body !== undefined) input += cfg("request", "POST") + cfg("data", body) + cfg("header", "content-type: application/x-www-form-urlencoded");
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: any) => reject(Object.assign(new Error(e.code === "ENOENT" ? "curl not found" : String(e.message)), { noCurl: e.code === "ENOENT" })));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`curl failed (exit ${code}): ${err.trim().split("\n").pop()}`));
      const i = out.lastIndexOf("\n");
      const [status, contentType, finalUrl] = out.slice(i + 1).split("\t");
      resolve({ status: Number(status), contentType: contentType || "unknown", finalUrl: finalUrl || url, text: out.slice(0, i) });
    });
    child.stdin.end(input);
  });
}

async function fetchRequest(url: string, body?: string): Promise<Resp> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    body,
    headers: { "user-agent": UA, ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "unknown", finalUrl: res.url, text: await res.text() };
}

async function httpRequest(url: string, body?: string): Promise<Resp> {
  if ((process.env.ECLASS_TRANSPORT ?? "curl") === "fetch") return fetchRequest(url, body);
  try {
    return await curlRequest(url, body);
  } catch (e: any) {
    if (e.noCurl) return fetchRequest(url, body);
    throw e;
  }
}

// ---- Moodle web service helper (read-only) ----
async function ws<T = any>(wsfunction: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!TOKEN) throw new Error("ECLASS_WS_TOKEN is not set.");
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
  let data: any;
  try { data = JSON.parse(raw); } catch {
    const u = new URL(res.finalUrl);
    throw new Error(
      `eClass did not return JSON (HTTP ${res.status}, ${res.contentType}, ended at ${u.host}${u.pathname}). ` +
      `Likely causes: a login/SSO redirect, a bot-protection challenge, a wrong ECLASS_BASE_URL, or web services disabled. ` +
      `Page text: "${snippet}"`,
    );
  }
  if (!(res.status >= 200 && res.status < 300) && !data?.exception) throw new Error(`HTTP ${res.status} from eClass web service`);
  if (data?.exception) throw new Error(`${data.errorcode}: ${data.message}`);
  return data as T;
}


// ---- Binary download (course files) ----
const MAX_FILE_MB = Number(process.env.ECLASS_MAX_FILE_MB ?? 25);
type Bin = { status: number; contentType: string; bytes: Buffer };

async function curlDownload(url: string): Promise<Bin> {
  const dir = await mkdtemp(join(tmpdir(), "eclass-mcp-"));
  const out = join(dir, "file");
  try {
    const cfg = (k: string, v: string) => `${k} = "${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    const meta: string = await new Promise((resolve, reject) => {
      const child = spawn("curl", ["-sS", "-L", "--max-time", String(Math.max(60, TIMEOUT_MS / 1000)),
        "--max-filesize", String(Math.max(1, Math.floor(MAX_FILE_MB * 1024 * 1024))), "-K", "-", "-w", "%{http_code}\t%{content_type}"]);
      let o = "", e = "";
      child.stdout.on("data", (d) => (o += d));
      child.stderr.on("data", (d) => (e += d));
      child.on("error", (err: any) => reject(Object.assign(new Error(err.code === "ENOENT" ? "curl not found" : String(err.message)), { noCurl: err.code === "ENOENT" })));
      child.on("close", (code) => code === 0 ? resolve(o)
        : reject(new Error(code === 63 ? `File is larger than ${MAX_FILE_MB} MB (ECLASS_MAX_FILE_MB).` : `curl failed (exit ${code}): ${e.trim().split("\n").pop()}`)));
      child.stdin.end(cfg("url", url) + cfg("output", out));
    });
    const [status, contentType] = meta.split("\t");
    return { status: Number(status), contentType: contentType || "unknown", bytes: await readFile(out) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchDownload(url: string): Promise<Bin> {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(Math.max(60000, TIMEOUT_MS)) });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_FILE_MB * 1024 * 1024) throw new Error(`File is larger than ${MAX_FILE_MB} MB (ECLASS_MAX_FILE_MB).`);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "unknown", bytes };
}

async function downloadFile(url: string): Promise<Bin> {
  if ((process.env.ECLASS_TRANSPORT ?? "curl") === "fetch") return fetchDownload(url);
  try { return await curlDownload(url); } catch (e: any) { if (e.noCurl) return fetchDownload(url); throw e; }
}

// Only ever send the token to this eClass site's own file endpoint.
function eclassFileUrl(raw: string): URL {
  const base = assertSafeUrl(BASE, "ECLASS_BASE_URL");
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("file_url is not a valid URL. Use a file_url from list_course_files."); }
  if (u.origin !== base.origin || !/\/(webservice\/)?pluginfile\.php\//.test(u.pathname))
    throw new Error("file_url must be an eClass file link from list_course_files (refusing to send the token elsewhere).");
  u.pathname = u.pathname.replace(/^(.*?)\/pluginfile\.php\//, (m, pre) => pre.endsWith("/webservice") ? m : `${pre}/webservice/pluginfile.php/`);
  u.searchParams.delete("token");
  u.searchParams.set("token", TOKEN!);
  return u;
}

function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Bad pages value "${spec}". Use e.g. "1-3,7".`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}


// Collapse whitespace and drop empty lines.
function tidy(t: string): string {
  return t.replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).filter(Boolean).join("\n");
}
// Remove header/footer lines that repeat on most pages (digits ignored, so "Page 3 of 9" counts as repeated).
function stripRepeated(pages: string[]): string[] {
  if (pages.length < 3) return pages;
  const norm = (l: string) => l.toLowerCase().replace(/\d+/g, "#");
  const seen = new Map<string, number>();
  for (const t of pages) {
    const lines = t.split("\n");
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(norm));
    for (const k of edge) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const repeated = new Set([...seen].filter(([, n]) => n >= Math.max(3, pages.length * 0.6)).map(([k]) => k));
  if (!repeated.size) return pages;
  return pages.map((t) => {
    const lines = t.split("\n");
    while (lines.length && repeated.has(norm(lines[0]))) lines.shift();
    while (lines.length && repeated.has(norm(lines[lines.length - 1]))) lines.pop();
    return lines.join("\n");
  });
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;

const fmtDate = (d: Date | number) =>
  new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });

const server = new McpServer({ name: "eclass", version: "0.1.0" });

// ---- ICS tools ----
server.registerTool(
  "get_upcoming_deadlines",
  {
    description: "List upcoming eClass deadlines (assignments, quizzes). Uses the web service token if set, otherwise the exported ICS calendar feed.",
    inputSchema: { days: z.number().int().min(1).max(365).default(14).describe("How many days ahead to look") },
  },
  async ({ days }) => {
    if (TOKEN) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const r: any = await ws("core_calendar_get_action_events_by_timesort", {
          timesortfrom: now, timesortto: now + days * 86400, limitnum: 50,
        });
        const rows = ((r.events ?? []) as any[])
          .sort((a, b) => a.timesort - b.timesort)
          .map((e) => `${fmtDate(e.timesort * 1000)} — ${e.name}${e.course?.shortname ? ` [${e.course.shortname}]` : ""}`);
        return text(rows.length ? rows.join("\n") : `No events in the next ${days} days.`);
      } catch (e: any) {
        if (!ICS_URL) return fail(scrub(String(e.message)));
        // otherwise fall through to the ICS feed
      }
    }
    if (!ICS_URL) return fail("Set ECLASS_WS_TOKEN, or ECLASS_ICS_URL (eClass: Calendar > Import or export calendars > Export).");
    try {
      assertSafeUrl(ICS_URL, "ECLASS_ICS_URL");
      const res = await httpRequest(ICS_URL);
      if (!(res.status >= 200 && res.status < 300)) throw new Error(`HTTP ${res.status} (the export URL may have been regenerated or expired, or blocked by a firewall challenge)`);
      const body = res.text;
      if (!body.includes("BEGIN:VCALENDAR")) throw new Error("Response was not an ICS calendar (got a login page?).");
      const events = ical.sync.parseICS(body);
      const now = Date.now();
      const end = now + days * 86400_000;
      const rows = Object.values(events)
        .filter((e: any) => e.type === "VEVENT" && e.start)
        .map((e: any) => ({ start: new Date(e.start).getTime(), title: e.summary, course: e.categories?.join(", ") ?? "", desc: e.description }))
        .filter((e) => e.start >= now && e.start <= end)
        .sort((a, b) => a.start - b.start)
        .map((e) => `${fmtDate(e.start)} — ${e.title}${e.course ? ` [${e.course}]` : ""}`);
      return text(rows.length ? rows.join("\n") : `No events in the next ${days} days.`);
    } catch (e: any) {
      return fail(`Failed to read ICS feed: ${scrub(String(e.message))}`);
    }
  },
);

// ---- Web service tools (registered only if a token is configured) ----
if (TOKEN) {
  let userId: number | undefined;
  const getUserId = async () => (userId ??= (await ws("core_webservice_get_site_info")).userid);

  server.registerTool(
    "check_connection",
    { description: "Verify the eClass web service token works and show the signed-in user.", inputSchema: {} },
    async () => {
      try {
        const i = await ws("core_webservice_get_site_info");
        return text(`Connected to ${i.sitename} as ${i.fullname} (id ${i.userid}). Moodle ${i.release}.`);
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  server.registerTool(
    "list_courses",
    { description: "List the courses you are enrolled in.", inputSchema: {} },
    async () => {
      try {
        const courses: any[] = await ws("core_enrol_get_users_courses", { userid: await getUserId() });
        return text(courses.map((c) => `${c.id}: ${c.fullname} (${c.shortname})`).join("\n") || "No courses.");
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  server.registerTool(
    "get_assignments",
    {
      description: "List assignments and due dates for a course.",
      inputSchema: { course_id: z.number().int() },
    },
    async ({ course_id }) => {
      try {
        const r: any = await ws("mod_assign_get_assignments", { "courseids[0]": course_id });
        const list = (r.courses?.[0]?.assignments ?? []) as any[];
        return text(
          list
            .map((a) => `${a.name} — due ${a.duedate ? fmtDate(a.duedate * 1000) : "no due date"} (id ${a.id})`)
            .join("\n") || "No assignments.",
        );
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  server.registerTool(
    "get_grades",
    {
      description: "Get your grade items for a course.",
      inputSchema: { course_id: z.number().int() },
    },
    async ({ course_id }) => {
      try {
        const r: any = await ws("gradereport_user_get_grade_items", { courseid: course_id, userid: await getUserId() });
        const items = (r.usergrades?.[0]?.gradeitems ?? []) as any[];
        return text(
          items
            .map((g) => `${g.itemname ?? "Course total"}: ${g.gradeformatted ?? "-"} (range ${g.grademin}-${g.grademax})`)
            .join("\n") || "No grades.",
        );
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );


  server.registerTool(
    "list_course_files",
    {
      description: "List the files (PDFs, slides, documents) attached to a course's resources and folders, with a file_url to pass to read_course_file.",
      inputSchema: { course_id: z.number().int(), name_contains: z.string().optional().describe("Only files whose name or activity contains this text (case-insensitive)") },
    },
    async ({ course_id, name_contains }) => {
      try {
        const sections: any[] = await ws("core_course_get_contents", { courseid: course_id });
        const q = name_contains?.toLowerCase();
        const rows: string[] = [];
        for (const s of sections) for (const m of s.modules ?? []) for (const f of m.contents ?? []) {
          if (f.type !== "file" || !f.fileurl) continue;
          const label = `${s.name} / ${m.name} / ${f.filename}`;
          if (q && !label.toLowerCase().includes(q)) continue;
          const kb = f.filesize ? ` ${(f.filesize / 1024).toFixed(0)} KB` : "";
          rows.push(`- ${label} (${f.mimetype ?? "unknown"}${kb})\n  file_url: ${f.fileurl}`);
        }
        return text(rows.length ? rows.join("\n") : "No downloadable files found" + (q ? ` matching "${name_contains}".` : "."));
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  // Download a file once and return cleaned text per page (non-PDFs are one "page").
  async function loadFile(file_url: string): Promise<{ pdf: boolean; pages: string[] } | { unsupported: string } | { scanned: number }> {
    const url = eclassFileUrl(file_url);
    const res = await downloadFile(url.toString());
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} downloading file`);
    if (res.bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      const { getDocumentProxy, extractText } = await import("unpdf");
      const { text: per } = await extractText(await getDocumentProxy(new Uint8Array(res.bytes)), { mergePages: false });
      const pages = stripRepeated((per as string[]).map(tidy));
      if (!pages.some((t) => t.trim())) return { scanned: pages.length };
      return { pdf: true, pages };
    }
    if (TEXT_TYPES.test(res.contentType) || /\.(txt|md|csv|json|xml|html?)$/i.test(url.pathname)) {
      const t = res.bytes.toString("utf8");
      if (/^\s*\{\s*"(error|exception)"/.test(t)) { const j = JSON.parse(t); throw new Error(j.error ?? j.message ?? "eClass refused the file"); }
      const body = res.contentType.includes("html") ? t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ") : t;
      return { pdf: false, pages: [tidy(body)] };
    }
    return { unsupported: res.contentType };
  }
  const notText = (r: any) =>
    "unsupported" in r ? fail(`Unsupported file type (${r.unsupported}). Only PDFs and text files can be read for now.`)
    : "scanned" in r ? text(`PDF has ${r.scanned} pages but no text layer (probably scanned images). OCR is not supported.`) : null;
  const cap = (out: string, max: number, hint: string) =>
    out.length > max ? out.slice(0, max) + `\n\n[truncated at ${max} of ${out.length} chars. ${hint}]` : out;

  server.registerTool(
    "outline_course_file",
    {
      description: "Cheap first look at a course file: page count, size of each page and its first line (usually the heading). Use before reading so you can pick pages.",
      inputSchema: { file_url: z.string().describe("A file_url from list_course_files") },
    },
    async ({ file_url }) => {
      try {
        const r = await loadFile(file_url);
        const bad = notText(r); if (bad) return bad;
        const { pdf, pages } = r as { pdf: boolean; pages: string[] };
        const total = pages.reduce((n, t) => n + t.length, 0);
        const rows = pages.map((t, i) => {
          const first = t.split("\n").map((l) => l.trim()).find(Boolean) ?? "(blank)";
          return `p.${i + 1} (${t.length} chars): ${first.slice(0, 90)}`;
        });
        return text(`${pdf ? `PDF, ${pages.length} pages` : "Text file"}, ${total} chars in total.\n` +
          cap(rows.join("\n"), 4000, "Long document; use search_course_file."));
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  server.registerTool(
    "search_course_file",
    {
      description: "Find text inside a course file and return only the matching lines with page numbers. Prefer this over read_course_file to answer a specific question (exam dates, late policy, weights). Separate alternatives with |, e.g. \"exam|midterm|test\".",
      inputSchema: {
        file_url: z.string().describe("A file_url from list_course_files"),
        query: z.string().min(1).describe("Words to find (case-insensitive). Use | for alternatives"),
        context_lines: z.number().int().min(0).max(5).default(1).describe("Lines to include around each match"),
        max_results: z.number().int().min(1).max(50).default(15),
      },
    },
    async ({ file_url, query, context_lines, max_results }) => {
      try {
        const r = await loadFile(file_url);
        const bad = notText(r); if (bad) return bad;
        const { pdf, pages } = r as { pdf: boolean; pages: string[] };
        const terms = query.split("|").map((q) => q.trim().toLowerCase()).filter(Boolean);
        const hits: string[] = []; let count = 0;
        pages.forEach((t, pi) => {
          const lines = t.split("\n");
          let lastEnd = -1;
          lines.forEach((l, li) => {
            if (count >= max_results || !terms.some((q) => l.toLowerCase().includes(q))) return;
            count++;
            const from = Math.max(li - context_lines, lastEnd + 1), to = Math.min(lines.length - 1, li + context_lines);
            if (from > to) return;
            const where = pdf ? `p.${pi + 1}` : `line ${li + 1}`;
            hits.push(`${where}: ${lines.slice(from, to + 1).map((x) => x.trim()).filter(Boolean).join(" / ")}`);
            lastEnd = to;
          });
        });
        if (!hits.length) return text(`No matches for "${query}" in ${pages.length} ${pdf ? "pages" : "file"}. Try other words or outline_course_file.`);
        return text(cap(`${count} match${count === 1 ? "" : "es"}${count >= max_results ? " (limit reached)" : ""}:\n` + hits.join("\n"), 6000, "Narrow the query."));
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  server.registerTool(
    "read_course_file",
    {
      description: "Return the text of a course file (PDF text layer or plain text). This can be long: prefer search_course_file, or outline_course_file then read specific pages.",
      inputSchema: {
        file_url: z.string().describe("A file_url from list_course_files"),
        pages: z.string().optional().describe('PDF pages to read, e.g. "1-3,7". Default: all'),
        max_chars: z.number().int().min(500).max(100000).default(6000).describe("Truncate the returned text to this many characters"),
      },
    },
    async ({ file_url, pages, max_chars }) => {
      try {
        const r = await loadFile(file_url);
        const bad = notText(r); if (bad) return bad;
        const { pdf, pages: per } = r as { pdf: boolean; pages: string[] };
        if (!pdf) return text(cap(per[0], max_chars, "Use search_course_file, or raise max_chars."));
        const want = parsePages(pages, per.length);
        const body = want.map((n) => `--- page ${n} ---\n${per[n - 1]}`).join("\n\n");
        return text(cap(`PDF, ${per.length} pages (showing ${want.length}).\n\n${body}`, max_chars,
          "Use search_course_file or the pages parameter, or raise max_chars."));
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );

  server.registerTool(
    "get_course_contents",
    {
      description: "List the sections and activities/resources in a course.",
      inputSchema: { course_id: z.number().int() },
    },
    async ({ course_id }) => {
      try {
        const sections: any[] = await ws("core_course_get_contents", { courseid: course_id });
        return text(
          sections
            .map((s) => `## ${s.name}\n` + (s.modules ?? []).map((m: any) => `- [${m.modname}] ${m.name}`).join("\n"))
            .join("\n\n"),
        );
      } catch (e: any) {
        return fail(scrub(String(e.message)));
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`eclass MCP running (ICS: ${ICS_URL ? "on" : "off"}, API: ${TOKEN ? "on" : "off"})`);

// Exit when the client disconnects (otherwise the --demo mock server would keep the process alive).
process.stdin.on("close", () => process.exit(0));
