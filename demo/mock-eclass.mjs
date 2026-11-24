// Minimal fake York eClass: Moodle web service + ICS export. For demos/tests only.
import http from "node:http";

export const GOOD_TOKEN = "demo-token-1234567890";
const day = 86400;
const now = Math.floor(Date.now() / 1000);

const courses = [
  { id: 101, fullname: "EECS 2311 Software Development Project", shortname: "EECS2311" },
  { id: 102, fullname: "MATH 1025 Applied Calculus II", shortname: "MATH1025" },
];
const assignments = {
  101: [{ id: 1, name: "Sprint 1 Report", duedate: now + 2 * day }, { id: 2, name: "Final Demo", duedate: now + 20 * day }],
  102: [{ id: 3, name: "Problem Set 4", duedate: now + 5 * day }, { id: 4, name: "Reading Reflection", duedate: 0 }],
};
const grades = {
  101: [{ itemname: "Sprint 1 Report", gradeformatted: "88.00", grademin: 0, grademax: 100 }, { itemname: null, gradeformatted: "88.00", grademin: 0, grademax: 100 }],
  102: [],
};
const contents = {
  101: [{ name: "Week 1", modules: [{ modname: "resource", name: "Syllabus.pdf" }, { modname: "assign", name: "Sprint 1 Report" }] }],
  102: [{ name: "General", modules: [{ modname: "forum", name: "Announcements" }] }],
};

const ics = (secs) => new Date(secs * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
export const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mock//EN",
  ...[["Sprint 1 Report is due", now + 2 * day, "EECS2311"], ["Problem Set 4 is due", now + 5 * day, "MATH1025"],
      ["Final Demo is due", now + 20 * day, "EECS2311"], ["Old Quiz closes", now - 3 * day, "MATH1025"]]
    .flatMap(([s, t, c], i) => ["BEGIN:VEVENT", `UID:${i}@mock`, `DTSTAMP:${ics(now)}`, `DTSTART:${ics(t)}`, `SUMMARY:${s}`, `CATEGORIES:${c}`, "END:VEVENT"]),
  "END:VCALENDAR",
].join("\r\n");

export function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/calendar/export_execute.php") {
      if (url.searchParams.get("userid") === "slow") return; // hang forever (timeout test)
      if (url.searchParams.get("authtoken") === "login") { res.setHeader("content-type", "text/html"); return res.end("<html>Passport York login</html>"); }
      if (url.searchParams.get("authtoken") === "gone") { res.statusCode = 404; return res.end("nope"); }
      res.setHeader("content-type", "text/calendar"); return res.end(ICS);
    }
    if (url.pathname === "/webservice/rest/server.php") {
      let body = ""; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      if (p.get("wstoken") === "html-token-123") { res.setHeader("content-type", "text/html"); return res.end("<html>SSO page</html>"); }
      const json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (p.get("wstoken") !== GOOD_TOKEN)
        return json({ exception: "moodle_exception", errorcode: "invalidtoken", message: `Invalid token - token not found (${p.get("wstoken")})` });
      const f = p.get("wsfunction"), cid = Number(p.get("courseid") ?? p.get("courseids[0]"));
      if (f === "core_webservice_get_site_info") return json({ sitename: "York eClass (mock)", fullname: "Demo Student", userid: 42, release: "4.1 (mock)" });
      if (f === "core_calendar_get_action_events_by_timesort") {
        const from = Number(p.get("timesortfrom")), to = Number(p.get("timesortto"));
        const all = [["Sprint 1 Report is due", now + 2 * day, "EECS2311"], ["Problem Set 4 is due", now + 5 * day, "MATH1025"], ["Final Demo is due", now + 20 * day, "EECS2311"]];
        return json({ events: all.filter(([, t]) => t >= from && t <= to).map(([name, timesort, shortname]) => ({ name, timesort, course: { shortname } })) });
      }
      if (f === "core_enrol_get_users_courses") return json(p.get("userid") === "42" ? courses : []);
      if (f === "mod_assign_get_assignments") return json({ courses: [{ id: cid, assignments: assignments[cid] ?? [] }] });
      if (f === "gradereport_user_get_grade_items") return json({ usergrades: [{ gradeitems: grades[cid] ?? [] }] });
      if (f === "core_course_get_contents") return json(contents[cid] ?? []);
      return json({ exception: "webservice_access_exception", errorcode: "accessexception", message: "Access control exception" });
    }
    res.statusCode = 404; res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { base } = await startMock();
  console.log(`Mock eClass running at ${base}\nECLASS_BASE_URL=${base}\nECLASS_WS_TOKEN=${GOOD_TOKEN}\nECLASS_ICS_URL=${base}/calendar/export_execute.php?authtoken=ok`);
}
