import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock, GOOD_TOKEN, captured } from "../demo/mock-eclass.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";

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
    assert.deepEqual(await names(c), ["check_connection", "get_assignments", "get_course_contents", "get_grades", "get_upcoming_deadlines", "list_course_files", "list_courses", "outline_course_file", "read_course_file", "search_course_file"]);
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
    assert.ok(!all.err, all.text); assert.match(all.text, /4 pages/); assert.match(all.text, /Midterm Test: October 21, 2026/);
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
    assert.ok(r.text.length <= 650, r.text);
    const big = await call(c, "read_course_file", { file_url: await fileUrl(c, "syllabus.pdf"), max_chars: 500, pages: "1-4" });
    assert.ok(big.text.length <= 650);
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

console.log("Token-saving file tools");
await test("default read is capped at 6000 chars and strips repeated header/footer", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "read_course_file", { file_url: await fileUrl(c, "syllabus.pdf") });
    assert.ok(r.text.length <= 6200);
    assert.ok(!/EECS 2311 Syllabus - Fall 2026/.test(r.text) && !/Page \d of 4/.test(r.text), r.text);
    assert.match(r.text, /Late sprints lose 10%/);
  }));
await test("outline shows page count and headings only", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "outline_course_file", { file_url: await fileUrl(c, "syllabus.pdf") });
    assert.ok(!r.err, r.text); assert.match(r.text, /PDF, 4 pages/); assert.match(r.text, /p\.2 \(\d+ chars\): Important Dates/);
    assert.ok(!/Midterm Test: October/.test(r.text), "outline must not include body text");
  }));
await test("search returns only matching lines with page numbers", () =>
  withServer(WS, async (c) => {
    const r = await call(c, "search_course_file", { file_url: await fileUrl(c, "syllabus.pdf"), query: "midterm test|final exam", context_lines: 0 });
    assert.ok(!r.err, r.text); assert.match(r.text, /p\.2: Midterm Test: October 21/); assert.match(r.text, /p\.1: .*Final Exam 35%/);
    assert.ok(!/Late sprints|Agile/.test(r.text), r.text);
    assert.ok(r.text.length < 500, `search output should be small (${r.text.length})`);
  }));
await test("search: no match, max_results limit, text files", () =>
  withServer(WS, async (c) => {
    const u = await fileUrl(c, "syllabus.pdf");
    assert.match((await call(c, "search_course_file", { file_url: u, query: "zzzz" })).text, /No matches/);
    assert.match((await call(c, "search_course_file", { file_url: u, query: "a", max_results: 2 })).text, /2 matches \(limit reached\)/);
    assert.match((await call(c, "search_course_file", { file_url: await fileUrl(c, "notes.txt"), query: "laptop" })).text, /line 1: Week 1 notes/);
  }));
await test("outline/search on scanned and unsupported files", () =>
  withServer(WS, async (c) => {
    assert.match((await call(c, "outline_course_file", { file_url: await fileUrl(c, "scan.pdf") })).text, /no text layer/);
    assert.ok((await call(c, "search_course_file", { file_url: await fileUrl(c, "slides.pptx"), query: "x" })).err);
  }));

console.log("Redirect safety");
for (const code of [301, 302, 307, 308]) for (const transport of ["curl", "fetch"]) {
  await test(`API ${code} redirect is not followed and the token is not resent (${transport})`, () =>
    withServer({ ...WS, ECLASS_TRANSPORT: transport, ECLASS_WS_TOKEN: `redirect-${code}-secret-token` }, async (c) => {
      captured.length = 0;
      const r = await call(c, "check_connection");
      assert.ok(r.err && /redirected/.test(r.text) && /not followed/.test(r.text), r.text);
      assert.equal(captured.length, 0, "token body reached the redirect target");
      assert.ok(!r.text.includes("secret-token"), "token echoed in error");
    }));
}

console.log("setup command (browser step simulated)");
const runSetup = (env) => new Promise((res) => execFile("node", [ENTRY, "setup"], { env: { PATH: process.env.PATH, ...env } }, (e, out) => res({ code: e ? e.code : 0, out })));
const link = (site, passport, token) => "moodlemobile://token=" + Buffer.from(createHash("md5").update(site + passport).digest("hex") + ":::" + token).toString("base64");
await test("valid link: verifies token, writes config, keeps other servers, never prints token", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/cfg-"); const cfgPath = dir + "/claude.json";
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
  const r = await runSetup({ ECLASS_BASE_URL: base, ECLASS_SETUP_CONFIG: cfgPath, ECLASS_SETUP_PASSPORT: "p1", ECLASS_SETUP_TEST_LINK: link(base, "p1", GOOD_TOKEN) });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Token works: .* as Demo Student/); assert.ok(!r.out.includes(GOOD_TOKEN), "token printed!");
  assert.ok(!/not created for this setup run/.test(r.out));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.mcpServers.eclass.env.ECLASS_WS_TOKEN, GOOD_TOKEN); assert.equal(cfg.mcpServers.other.command, "x"); assert.equal(cfg.theme, "dark");
  assert.deepEqual(cfg.mcpServers.eclass.args, ["-y", "github:keerthan9453/eclass-mcp"]);
  assert.ok(fs.existsSync(cfgPath + ".bak"));
  assert.equal(fs.statSync(cfgPath).mode & 0o077, 0, "config should be private");
});
await test("existing eclass entry: keeps its args, only updates the token", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/cfg-"); const cfgPath = dir + "/c.json";
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { eclass: { command: "npx", args: ["-y", "github:keerthan9453/eclass-mcp#abc"], env: { ECLASS_WS_TOKEN: "old", ECLASS_ICS_URL: "https://x" } } } }));
  const r = await runSetup({ ECLASS_BASE_URL: base, ECLASS_SETUP_CONFIG: cfgPath, ECLASS_SETUP_PASSPORT: "p", ECLASS_SETUP_TEST_LINK: link(base, "p", GOOD_TOKEN) });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Updated/);
  const e = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.eclass;
  assert.equal(e.args[1], "github:keerthan9453/eclass-mcp#abc"); assert.equal(e.env.ECLASS_ICS_URL, "https://x"); assert.equal(e.env.ECLASS_WS_TOKEN, GOOD_TOKEN);
});
await test("rejected token: fails, config untouched", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/cfg-"); const cfgPath = dir + "/c.json";
  const r = await runSetup({ ECLASS_BASE_URL: base, ECLASS_SETUP_CONFIG: cfgPath, ECLASS_SETUP_PASSPORT: "p", ECLASS_SETUP_TEST_LINK: link(base, "p", "abcdefabcdefabcdefabcdefabcdef12") });
  assert.equal(r.code, 1); assert.match(r.out, /rejected the token/); assert.ok(!fs.existsSync(cfgPath));
});
await test("garbage link and wrong signature are handled", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/cfg-");
  const bad = await runSetup({ ECLASS_BASE_URL: base, ECLASS_SETUP_CONFIG: dir + "/a.json", ECLASS_SETUP_TEST_LINK: "moodlemobile://token=bm9wZQ==" });
  assert.equal(bad.code, 1); assert.match(bad.out, /valid token/);
  const sig = await runSetup({ ECLASS_BASE_URL: base, ECLASS_SETUP_CONFIG: dir + "/b.json", ECLASS_SETUP_PASSPORT: "mine", ECLASS_SETUP_TEST_LINK: link(base, "someone-else", GOOD_TOKEN) });
  assert.equal(sig.code, 1, sig.out); assert.match(sig.out, /not created for this setup run/); assert.ok(!fs.existsSync(dir + "/b.json"), "config must not be written");
});
await test("invalid JSON config is not overwritten", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/cfg-"); const cfgPath = dir + "/c.json"; fs.writeFileSync(cfgPath, "{ broken");
  const r = await runSetup({ ECLASS_BASE_URL: base, ECLASS_SETUP_CONFIG: cfgPath, ECLASS_SETUP_PASSPORT: "p", ECLASS_SETUP_TEST_LINK: link(base, "p", GOOD_TOKEN) });
  assert.equal(r.code, 1); assert.match(r.out, /not valid JSON/); assert.equal(fs.readFileSync(cfgPath, "utf8"), "{ broken");
});
await test("non-macOS without test link points to manual steps", async () => {
  if (process.platform === "darwin") return;
  const r = await runSetup({});
  assert.equal(r.code, 1); assert.match(r.out, /macOS only/);
});

server.close();
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
