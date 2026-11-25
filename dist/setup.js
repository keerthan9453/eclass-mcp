// `eclass-mcp setup`: get a Moodle mobile token without DevTools and save it to the Claude Desktop config.
//
// How it works (macOS): eClass hands the mobile token to a `moodlemobile://token=...` link. We briefly
// register a tiny helper app for that link type, open the eClass launch page in the user's browser,
// and the helper writes the link to a private temp file. We decode it, verify it, check it works,
// save it, and remove the helper. The token is never printed.
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
const run = promisify(execFile);
const say = (s = "") => process.stdout.write(s + "\n");
const BUNDLE_ID = "io.github.keerthan9453.eclassmcp.login";
const APP_NAME = "eClass MCP Login";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
export const defaultConfigPath = () => join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json");
/** Decode `moodlemobile://token=BASE64` → token. Signature = md5(siteurl + passport). */
export function decodeLaunchLink(link, site, passport) {
    const b64 = link.trim().split("token=").pop() ?? "";
    const parts = Buffer.from(b64, "base64").toString("utf8").split(":::");
    const token = parts[1] ?? "";
    if (!/^[A-Za-z0-9_-]{16,}$/.test(token))
        throw new Error("The link did not contain a valid token.");
    const expected = createHash("md5").update(site.replace(/\/$/, "") + passport).digest("hex");
    return { token, signatureOk: parts[0] === expected };
}
/** Ask eClass who this token belongs to (via curl, which York's firewall accepts). */
export function siteInfo(site, token) {
    return new Promise((resolve, reject) => {
        const q = (v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        const cfg = `url = ${q(site.replace(/\/$/, "") + "/webservice/rest/server.php")}\n` +
            `data = ${q(new URLSearchParams({ wstoken: token, wsfunction: "core_webservice_get_site_info", moodlewsrestformat: "json" }).toString())}\n`;
        const c = spawn("curl", ["-sS", "--max-time", "20", "-K", "-"]);
        let out = "", err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("error", reject);
        c.on("close", (code) => {
            if (code !== 0)
                return reject(new Error(`Could not reach eClass: ${err.trim()}`));
            try {
                const j = JSON.parse(out);
                if (j.exception)
                    return reject(new Error(`eClass rejected the token (${j.errorcode}).`));
                resolve(j);
            }
            catch {
                reject(new Error("eClass did not return JSON (a firewall or login page may be in the way)."));
            }
        });
        c.stdin.end(cfg);
    });
}
/** Add or update the `eclass` server in a Claude Desktop config, keeping everything else. */
export async function saveToClaudeConfig(path, token, site) {
    let cfg = {};
    if (existsSync(path)) {
        const raw = (await readFile(path, "utf8")).trim();
        if (raw) {
            try {
                cfg = JSON.parse(raw);
            }
            catch {
                throw new Error(`${path} is not valid JSON; fix it or remove it, then run setup again.`);
            }
        }
        await copyFile(path, path + ".bak");
        await chmod(path + ".bak", 0o600);
    }
    else {
        await mkdir(dirname(path), { recursive: true });
    }
    const existed = !!cfg.mcpServers?.eclass;
    const prev = cfg.mcpServers?.eclass ?? {};
    const env = { ...(prev.env ?? {}), ECLASS_WS_TOKEN: token };
    if (site !== "https://eclass.yorku.ca")
        env.ECLASS_BASE_URL = site;
    cfg.mcpServers = {
        ...(cfg.mcpServers ?? {}),
        eclass: { command: prev.command ?? "npx", args: prev.args ?? ["-y", "github:keerthan9453/eclass-mcp"], env },
    };
    await writeFile(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
    return existed;
}
// ---- macOS link catcher ----
async function installCatcher(work, inbox) {
    const app = join(work, `${APP_NAME}.app`);
    const script = join(work, "catcher.applescript");
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await writeFile(script, `on open location theURL
  set fh to open for access (POSIX file "${esc(inbox)}") with write permission
  set eof fh to 0
  write theURL to fh
  close access fh
end open location
on run
end run
`);
    await run("osacompile", ["-o", app, script]);
    const plist = join(app, "Contents/Info.plist");
    const pb = (cmd) => run("/usr/libexec/PlistBuddy", ["-c", cmd, plist]).catch(() => undefined);
    await pb(`Set :CFBundleIdentifier ${BUNDLE_ID}`);
    await pb(`Add :CFBundleIdentifier string ${BUNDLE_ID}`);
    await pb("Delete :CFBundleURLTypes");
    await pb("Add :CFBundleURLTypes array");
    await pb("Add :CFBundleURLTypes:0 dict");
    await pb(`Add :CFBundleURLTypes:0:CFBundleURLName string ${APP_NAME}`);
    await pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes array");
    await pb("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string moodlemobile");
    await pb("Add :LSUIElement bool true");
    await run("codesign", ["--force", "--deep", "-s", "-", app]).catch(() => undefined); // re-sign after editing
    await run(LSREGISTER, ["-f", app]);
    await setDefaultHandler(BUNDLE_ID);
    return app;
}
function setDefaultHandler(bundleId) {
    const js = `ObjC.import("CoreServices"); $.LSSetDefaultHandlerForURLScheme($("moodlemobile"), $("${bundleId}"));`;
    return run("osascript", ["-l", "JavaScript", "-e", js]).catch(() => undefined);
}
async function moodleAppInstalled() {
    const r = await run("mdfind", ["kMDItemCFBundleIdentifier == 'com.moodle.moodlemobile'"]).catch(() => ({ stdout: "" }));
    return !!r.stdout.trim();
}
// Safari refuses to follow a server redirect to a custom link type ("address is invalid"),
// so prefer another installed browser. Returns the browser name used.
const BROWSERS = [
    ["chrome", "com.google.Chrome"], ["brave", "com.brave.Browser"], ["firefox", "org.mozilla.firefox"],
    ["edge", "com.microsoft.edgemac"], ["arc", "company.thebrowser.Browser"], ["vivaldi", "com.vivaldi.Vivaldi"],
    ["opera", "com.operasoftware.Opera"], ["safari", "com.apple.Safari"],
];
async function openInBrowser(url, choice) {
    const list = choice ? BROWSERS.filter(([n]) => n === choice.toLowerCase()) : BROWSERS;
    if (choice && !list.length)
        throw new Error(`Unknown --browser "${choice}". Use one of: ${BROWSERS.map(([n]) => n).join(", ")}.`);
    for (const [name, id] of list) {
        try {
            await run("open", ["-b", id, url]);
            return [name, id];
        }
        catch { /* not installed, try next */ }
    }
    throw new Error(choice ? `${choice} does not seem to be installed.` : "No supported browser found.");
}
// Fixed place for the helper, so a run that was interrupted can't leave a second copy catching the link.
const SETUP_DIR = () => join(homedir(), "Library/Application Support/eclass-mcp/setup");
/** Remove helpers left by earlier interrupted runs (old versions used temp folders). */
async function removeStaleHelpers() {
    const dirs = [SETUP_DIR()];
    for (const n of await readdir(tmpdir()).catch(() => []))
        if (n.startsWith("eclass-mcp-setup-"))
            dirs.push(join(tmpdir(), n));
    for (const d of dirs) {
        const app = join(d, `${APP_NAME}.app`);
        if (existsSync(app))
            await run(LSREGISTER, ["-u", app]).catch(() => undefined);
        await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
}
// AppleScript names for browsers whose current tab we can point at a URL.
const TAB_SCRIPT = {
    chrome: (u) => `tell application "Google Chrome" to set URL of active tab of front window to "${u}"`,
    brave: (u) => `tell application "Brave Browser" to set URL of active tab of front window to "${u}"`,
    edge: (u) => `tell application "Microsoft Edge" to set URL of active tab of front window to "${u}"`,
    vivaldi: (u) => `tell application "Vivaldi" to set URL of active tab of front window to "${u}"`,
    safari: (u) => `tell application "Safari" to set URL of current tab of front window to "${u}"`,
};
/** Load url in the browser's current (signed-in) tab. Returns false if that isn't possible. */
async function openInSameTab(browser, url) {
    const script = TAB_SCRIPT[browser];
    if (!script)
        return false;
    try {
        await run("osascript", ["-e", script(url)]);
        return true;
    }
    catch {
        return false;
    }
}
async function waitForFile(path, ms, onTick, accept = () => true) {
    const start = Date.now(), end = start + ms;
    let lastTick = 0;
    while (Date.now() < end) {
        const sec = Math.floor((Date.now() - start) / 1000);
        if (onTick && sec !== lastTick) {
            lastTick = sec;
            await onTick(sec);
        }
        if (existsSync(path)) {
            const t = (await readFile(path, "utf8")).trim();
            if (t.includes("token=")) {
                if (accept(t))
                    return t;
                await rm(path, { force: true }); // not from this run: discard and keep waiting
            }
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Timed out after 2 minutes without receiving the eClass link.");
}
export async function runSetup(argv) {
    const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const site = (arg("--site") ?? process.env.ECLASS_BASE_URL ?? "https://eclass.yorku.ca").replace(/\/$/, "");
    const configPath = arg("--config") ?? process.env.ECLASS_SETUP_CONFIG ?? defaultConfigPath();
    const passport = process.env.ECLASS_SETUP_PASSPORT ?? randomBytes(8).toString("hex");
    const testLink = process.env.ECLASS_SETUP_TEST_LINK; // lets the test suite skip the browser step
    say("eClass MCP setup\n");
    if (!testLink && process.platform !== "darwin") {
        say("Automatic setup currently works on macOS only.");
        say("Follow the manual steps instead: https://github.com/keerthan9453/eclass-mcp#b-web-service-token");
        return 1;
    }
    let work, app, hadMoodleApp = false;
    try {
        let link;
        if (testLink) {
            link = testLink;
        }
        else {
            await removeStaleHelpers();
            work = SETUP_DIR();
            await mkdir(work, { recursive: true });
            const inbox = join(work, "link.txt");
            const cleanupOnCtrlC = async () => {
                if (app)
                    await run(LSREGISTER, ["-u", app]).catch(() => undefined);
                await rm(work, { recursive: true, force: true }).catch(() => undefined);
                say("\nSetup cancelled.");
                process.exit(130);
            };
            process.once("SIGINT", cleanupOnCtrlC);
            hadMoodleApp = await moodleAppInstalled();
            if (hadMoodleApp)
                say("Note: the Moodle app is installed. If it opens instead of the setup helper, close it and run setup again.\n");
            app = await installCatcher(work, inbox);
            const launch = `${site}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;
            // Step 1: sign in first, so the token link isn't lost in the Passport York login redirects.
            const [used, bundleId] = await openInBrowser(`${site}/my/`, arg("--browser"));
            const nice = used[0].toUpperCase() + used.slice(1);
            say(`Step 1. eClass is opening in ${nice}. Sign in with Passport York until you see your Dashboard.`);
            if (used === "safari")
                say("        Safari usually can't hand the token over. If step 2 fails, install Chrome, Brave or Firefox and run setup again.");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            await rl.question("        Keep that tab in front, then press Return here... ");
            rl.close();
            // Step 2: load the token link in the same signed-in tab.
            say(`\nStep 2. Loading the token link in your signed-in ${nice} tab.`);
            const sameTab = await openInSameTab(used, launch);
            if (!sameTab)
                await run("open", ["-b", bundleId, launch]).catch(() => undefined);
            say(`        When ${nice} asks to open "${APP_NAME}", click Open (or Allow).`);
            if (sameTab)
                say("        (If macOS asks whether Terminal may control " + nice + ", click OK.)");
            say("        If nothing happens, paste this link into the signed-in eClass tab:");
            say(`        ${launch}`);
            say("        Waiting up to 2 minutes...\n");
            const fromThisRun = (l) => {
                try {
                    if (decodeLaunchLink(l, site, passport).signatureOk)
                        return true;
                }
                catch { /* malformed */ }
                say("        Ignored a moodlemobile:// link that did not come from this setup run. Still waiting...");
                return false;
            };
            link = await waitForFile(inbox, 2 * 60_000, async (sec) => {
                if (sec === 30) {
                    // Re-check: make sure our helper is still the one macOS hands the link to.
                    say("        No token yet after 30 seconds. Re-registering the helper and checking again...");
                    await run(LSREGISTER, ["-f", app]).catch(() => undefined);
                    await setDefaultHandler(BUNDLE_ID);
                    say("        Paste the link above into the signed-in tab now, and click Open when asked.\n");
                }
                if (sec === 75)
                    say("        Still waiting. If the browser shows an error instead of asking to open \"" + APP_NAME + "\",\n" +
                        "        press Ctrl+C and run setup again with another browser, e.g. --browser chrome.\n");
            }, fromThisRun);
            process.removeListener("SIGINT", cleanupOnCtrlC);
        }
        const { token, signatureOk } = decodeLaunchLink(link, site, passport);
        if (!signatureOk)
            throw new Error("The link was not created for this setup run (signature mismatch), so it was not trusted. Run setup again.");
        const info = await siteInfo(site, token);
        say(`✓ Token works: signed in to ${info.sitename} as ${info.fullname}.`);
        const updated = await saveToClaudeConfig(configPath, token, site);
        say(`✓ ${updated ? "Updated" : "Added"} the "eclass" server in ${configPath}${existsSync(configPath + ".bak") ? " (backup saved as .bak)" : ""}.`);
        say("\nDone. Quit Claude completely (Cmd+Q) and reopen it, then ask: \"Run check_connection on eclass\".");
        say("Your token was not shown. Keep that config file private.");
        return 0;
    }
    catch (e) {
        say(`\n✗ Setup failed: ${e.message}`);
        say("Manual steps: https://github.com/keerthan9453/eclass-mcp#b-web-service-token");
        return 1;
    }
    finally {
        if (app) {
            await run(LSREGISTER, ["-u", app]).catch(() => undefined);
            if (hadMoodleApp)
                await setDefaultHandler("com.moodle.moodlemobile");
        }
        if (work)
            await rm(work, { recursive: true, force: true });
    }
}
