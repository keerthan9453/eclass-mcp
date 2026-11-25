import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock, GOOD_TOKEN } from "../demo/mock-eclass.mjs";
import assert from "node:assert/strict";

const { server, base } = await startMock();
const ENTRY = new URL("../dist/index.js", import.meta.url).pathname;
let pass = 0, failed = 0;

async function withServer(env, fn) {
  const t = new StdioClientTransport({ command: "node", args: [ENTRY], env: { PATH: process.env.PATH, ...env }, stderr: "pipe" });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(t);
  try { await fn(c); } finally { await c.close(); }
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const ICS = (t) => `${base}/calendar/export_execute.php?authtoken=${t}`;
const names = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();

console.log("No configuration");
await test("only the ICS tool is exposed; clear error telling user what to set", () =>
  withServer({}, async (c) => {
    assert.deepEqual(await names(c), ["get_upcoming_deadlines"]);
    const r = await call(c, "get_upcoming_deadlines");
    assert.ok(r.err && /ECLASS_ICS_URL/.test(r.text) && /ECLASS_WS_TOKEN/.test(r.text));
  }));

console.log("ICS calendar only");
await test("lists future events in order, hides past ones", () =>
  withServer({ ECLASS_ICS_URL: ICS("ok") }, async (c) => {
    const r = await call(c, "get_upcoming_deadlines", { days: 14 });
    assert.ok(!r.err, r.text);
    const lines = r.text.split("\n");
    assert.equal(lines.length, 2, r.text);
    assert.match(lines[0], /Sprint 1 Report/); assert.match(lines[1], /Problem Set 4/);
    assert.ok(!/Old Quiz/.test(r.text) && !/Final Demo/.test(r.text));
  }));
await test("longer window includes later events", () =>
  withServer({ ECLASS_ICS_URL: ICS("ok") }, async (c) => {
    assert.match((await call(c, "get_upcoming_deadlines", { days: 30 })).text, /Final Demo/);
  }));
await test("empty window says so instead of failing", () =>
  withServer({ ECLASS_ICS_URL: ICS("ok") }, async (c) => {
    const r = await call(c, "get_upcoming_deadlines", { days: 1 });
    assert.ok(!r.err); assert.match(r.text, /No events/);
  }));
await test("rejects out-of-range input (days=0)", () =>
  withServer({ ECLASS_ICS_URL: ICS("ok") }, async (c) => {
    const r = await call(c, "get_upcoming_deadlines", { days: 0 });
    assert.ok(r.err);
  }));
await test("login page instead of ICS → helpful error, URL not leaked", () =>
  withServer({ ECLASS_ICS_URL: ICS("login") }, async (c) => {
    const r = await call(c, "get_upcoming_deadlines");
    assert.ok(r.err && /not an ICS/.test(r.text)); assert.ok(!r.text.includes("authtoken=login"));
  }));
await test("expired/regenerated URL (404) → error mentions it", () =>
  withServer({ ECLASS_ICS_URL: ICS("gone") }, async (c) => {
    const r = await call(c, "get_upcoming_deadlines");
    assert.ok(r.err && /404/.test(r.text));
  }));
await test("hung server → times out instead of hanging", () =>
  withServer({ ECLASS_ICS_URL: `${base}/calendar/export_execute.php?userid=slow`, ECLASS_TIMEOUT_MS: "500" }, async (c) => {
    const t0 = Date.now(); const r = await call(c, "get_upcoming_deadlines");
    assert.ok(r.err && Date.now() - t0 < 5000, r.text);
  }));
await test("plain-http non-local URL is refused", () =>
  withServer({ ECLASS_ICS_URL: "http://eclass.example.com/cal.ics" }, async (c) => {
    const r = await call(c, "get_upcoming_deadlines");
    assert.ok(r.err && /https/.test(r.text));
  }));
await test("garbage URL is refused", () =>
  withServer({ ECLASS_ICS_URL: "not a url" }, async (c) => {
    assert.ok((await call(c, "get_upcoming_deadlines")).err);
  }));

console.log("Moodle web service (token)");
const WS = { ECLASS_BASE_URL: base, ECLASS_WS_TOKEN: GOOD_TOKEN };
await test("all tools exposed when token set", () =>
  withServer(WS, async (c) => {
    assert.deepEqual(await names(c), ["check_connection", "get_assignments", "get_course_contents", "get_grades", "get_upcoming_deadlines", "list_course_files", "list_courses", "read_course_file"]);
  }));
await test("fetch transport still works (ECLASS_TRANSPORT=fetch)", () =>
  withServer({ ...WS, ECLASS_TRANSPORT: "fetch" }, async (c) => { assert.match((await call(c, "check_connection")).text, /Demo Student/); }));
await test("deadlines work from the token alone (no ICS URL)", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "get_upcoming_deadlines", { days: 14 });
    assert.ok(!r.err, r.text); assert.match(r.text, /Sprint 1 Report/); assert.match(r.text, /Problem Set 4/); assert.ok(!/Final Demo/.test(r.text));
  }));
await test("check_connection shows site + user", () =>
  withServer(WS, async (c) => { assert.match((await call(c, "check_connection")).text, /Demo Student/); }));
await test("list_courses", () =>
  withServer(WS, async (c) => { const r = await call(c, "list_courses"); assert.match(r.text, /101: EECS 2311/); assert.match(r.text, /102: MATH 1025/); }));
await test("get_assignments incl. 'no due date'", () =>
  withServer(WS, async (c) => {
    const a = await call(c, "get_assignments", { course_id: 101 }); assert.match(a.text, /Sprint 1 Report — due/);
    assert.match((await call(c, "get_assignments", { course_id: 102 })).text, /no due date/);
  }));
await test("get_grades incl. course total row and empty course", () =>
  withServer(WS, async (c) => {
    assert.match((await call(c, "get_grades", { course_id: 101 })).text, /Course total: 88.00/);
    assert.match((await call(c, "get_grades", { course_id: 102 })).text, /No grades/);
  }));
await test("get_course_contents", () =>
  withServer(WS, async (c) => { assert.match((await call(c, "get_course_contents", { course_id: 101 })).text, /## Week 1\n- \[resource\] Syllabus.pdf/); }));
await test("unknown course → empty result, not a crash", () =>
  withServer(WS, async (c) => { assert.ok(!(await call(c, "get_assignments", { course_id: 999 })).err); }));
await test("wrong course_id type rejected by schema", () =>
  withServer(WS, async (c) => { assert.ok((await call(c, "get_grades", { course_id: "abc" })).err); }));
await test("invalid token → clear error and the bad token is NOT echoed back", () =>
  withServer({ ...WS, ECLASS_WS_TOKEN: "bad-secret-token" }, async (c) => {
    const r = await call(c, "check_connection");
    assert.ok(r.err && /invalidtoken/.test(r.text)); assert.ok(!r.text.includes("bad-secret-token"), r.text);
  }));
await test("web services disabled (HTML back) → explains likely cause", () =>
  withServer({ ...WS, ECLASS_WS_TOKEN: "html-token-123" }, async (c) => {
    const r = await call(c, "check_connection");
    assert.ok(r.err && /did not return JSON/.test(r.text) && /HTTP 200/.test(r.text) && /text\/html/.test(r.text) && /SSO page/.test(r.text), r.text);
  }));
await test("token over plain http to a non-local host is refused", () =>
  withServer({ ECLASS_BASE_URL: "http://eclass.example.com", ECLASS_WS_TOKEN: "t" }, async (c) => {
    const r = await call(c, "check_connection"); assert.ok(r.err && /https/.test(r.text));
  }));
await test("unreachable host → error, no hang", () =>
  withServer({ ECLASS_BASE_URL: "http://127.0.0.1:9", ECLASS_WS_TOKEN: "t", ECLASS_TIMEOUT_MS: "1000" }, async (c) => {
    assert.ok((await call(c, "list_courses")).err);
  }));

console.log("Course files");
const fileUrl = async (c, name) => (await call(c, "list_course_files", { course_id: 101 })).text.split("\n").find((l, i, a) => a[i - 1]?.includes(name))?.trim().replace("file_url: ", "");
await test("list_course_files lists files with urls, filter works", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "list_course_files", { course_id: 101 });
    assert.match(r.text, /Syllabus.pdf \/ syllabus.pdf \(application\/pdf/); assert.match(r.text, /file_url: http/);
    assert.ok(!r.text.includes(GOOD_TOKEN), "token must not appear in listing");
    const f = await call(c, "list_course_files", { course_id: 101, name_contains: "notes" });
    assert.equal(f.text.split("\n").length, 2, f.text);
    assert.match((await call(c, "list_course_files", { course_id: 102 })).text, /No downloadable files/);
  }));
await test("read_course_file extracts PDF text, all pages and page ranges", () =>
  withServer(WS, async (c) => {
    const u = await fileUrl(c, "syllabus.pdf");
    const all = await call(c, "read_course_file", { file_url: u });
    assert.ok(!all.err, all.text); assert.match(all.text, /2 pages/); assert.match(all.text, /Midterm Test: October 21, 2026/);
    const p2 = await call(c, "read_course_file", { file_url: u, pages: "2" });
    assert.ok(!/Instructor/.test(p2.text) && /Important Dates/.test(p2.text), p2.text);
  }));
await test("read_course_file works over fetch transport too", () =>
  withServer({ ...WS, ECLASS_TRANSPORT: "fetch" }, async (c) => {
    assert.match((await call(c, "read_course_file", { file_url: await fileUrl(c, "syllabus.pdf") })).text, /Final Exam/);
  }));
await test("max_chars truncates with a note", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "read_course_file", { file_url: await fileUrl(c, "syllabus.pdf"), max_chars: 500 });
    assert.ok(r.text.length < 700 || /truncated/.test(r.text), r.text);
  }));
await test("scanned PDF (no text layer) is reported, not crashed", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "read_course_file", { file_url: await fileUrl(c, "scan.pdf") });
    assert.ok(!r.err); assert.match(r.text, /no text layer/);
  }));
await test("plain text file is read", () =>
  withServer(WS, async (c) => { assert.match((await call(c, "read_course_file", { file_url: await fileUrl(c, "notes.txt") })).text, /bring a laptop/); }));
await test("unsupported type (pptx) gives a clear error", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "read_course_file", { file_url: await fileUrl(c, "slides.pptx") });
    assert.ok(r.err && /Unsupported file type/.test(r.text));
  }));
await test("refuses to send the token to a non-eClass URL", () =>
  withServer(WS, async (c) => {
    for (const u of ["https://evil.example.com/webservice/pluginfile.php/1/x.pdf", `${base}/login/index.php`, "nonsense"]) {
      const r = await call(c, "read_course_file", { file_url: u });
      assert.ok(r.err && /file_url/.test(r.text), u + " -> " + r.text);
    }
  }));
await test("non-webservice pluginfile URL is rewritten to the token endpoint", () =>
  withServer(WS, async (c) => {
    const u = (await fileUrl(c, "syllabus.pdf")).replace("/webservice/pluginfile.php", "/pluginfile.php");
    assert.match((await call(c, "read_course_file", { file_url: u })).text, /Midterm/);
  }));
await test("file over ECLASS_MAX_FILE_MB is refused", () =>
  withServer({ ...WS, ECLASS_MAX_FILE_MB: "0.0005" }, async (c) => {
    const r = await call(c, "read_course_file", { file_url: await fileUrl(c, "syllabus.pdf") });
    assert.ok(r.err && /larger than/.test(r.text), r.text);
  }));
await test("bad token on file download gives an error without leaking token", () =>
  withServer({ ...WS, ECLASS_WS_TOKEN: "bad-secret-token" }, async (c) => {
    const r = await call(c, "read_course_file", { file_url: `${base}/webservice/pluginfile.php/1/mod_resource/content/0/syllabus.pdf` });
    assert.ok(r.err && !r.text.includes("bad-secret-token"), r.text);
  }));

server.close();
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
