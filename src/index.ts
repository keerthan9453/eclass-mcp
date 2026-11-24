#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
  const res = await fetch(`${BASE}/webservice/rest/server.php`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from eClass web service`);
  let data: any;
  try { data = await res.json(); } catch {
    throw new Error("eClass did not return JSON. Web services may be disabled, or the URL/login redirect is wrong.");
  }
  if (data?.exception) throw new Error(`${data.errorcode}: ${data.message}`);
  return data as T;
}

const fmtDate = (d: Date | number) =>
  new Date(d).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" });

const server = new McpServer({ name: "eclass", version: "0.1.0" });

// ---- ICS tools ----
server.registerTool(
  "get_upcoming_deadlines",
  {
    description: "List upcoming eClass calendar events (assignment due dates, quizzes) from the exported ICS feed.",
    inputSchema: { days: z.number().int().min(1).max(365).default(14).describe("How many days ahead to look") },
  },
  async ({ days }) => {
    if (!ICS_URL) return fail("ECLASS_ICS_URL is not set. Export it from eClass: Calendar > Import or export calendars.");
    try {
      assertSafeUrl(ICS_URL, "ECLASS_ICS_URL");
      const res = await fetch(ICS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} (the export URL may have been regenerated or expired)`);
      const body = await res.text();
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
