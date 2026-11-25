// Live walkthrough: launches the server in --demo mode and calls each tool like an MCP client would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const entry = new URL("../dist/index.js", import.meta.url).pathname;
const c = new Client({ name: "demo", version: "1" });
await c.connect(new StdioClientTransport({ command: "node", args: [entry, "--demo"], stderr: "ignore" }));
const show = async (name, args = {}) => {
  console.log(`\n▶ ${name}(${JSON.stringify(args)})`);
  const r = await c.callTool({ name, arguments: args });
  console.log(r.content.map((x) => x.text).join("\n").replace(/^/gm, "   "));
};
console.log("Tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));
await show("check_connection");
await show("list_courses");
await show("get_upcoming_deadlines", { days: 7 });
await show("get_assignments", { course_id: 101 });
await show("get_grades", { course_id: 101 });
await show("get_course_contents", { course_id: 101 });
await show("list_course_files", { course_id: 101, name_contains: "syllabus" });
const files = (await c.callTool({ name: "list_course_files", arguments: { course_id: 101, name_contains: "syllabus" } })).content[0].text;
await show("read_course_file", { file_url: files.match(/file_url: (\S+)/)[1], pages: "2" });
await c.close();
