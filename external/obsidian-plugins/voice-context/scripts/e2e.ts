// Deploys the bundle, reloads the plugin, drives scripts/e2e-page.js inside the running app, and prints one line per check.
// Usage: bun run e2e [--live]   --live also calls the real OpenAI endpoints with the configured credentials.
const CLI = "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli";
const live = process.argv.includes("--live");

async function cli(...args: string[]): Promise<string> {
	const proc = Bun.spawn([CLI, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`${args[0]}: ${err || out}`);
	return out.trim();
}

const evalCode = async (code: string) => (await cli("eval", `code=${code}`)).replace(/^=>\s*/, "");

if ((await evalCode(`app.plugins.plugins['voice-context']?.controller.status`)) !== "idle") {
	console.error("Voice Context is busy or not loaded. Stop recording first.");
	process.exit(2);
}

// Taken from the running app: a missing $VAULT would skip the copy and silently test a stale bundle.
const VAULT = await evalCode("app.vault.adapter.getBasePath()");
if ((await Bun.spawn(["bun", "run", "deploy"], { stdout: "inherit", stderr: "inherit", env: { ...process.env, VAULT } }).exited) !== 0) process.exit(2);
await cli("plugin:reload", "id=voice-context");

const page = await Bun.file(new URL("./e2e-page.js", import.meta.url)).text();
// Base64 keeps the CLI from rewriting `\n` and quotes inside the script.
const b64 = Buffer.from(page).toString("base64");
await evalCode(
	`window.__vcE2E=null;window.__vcE2ELive=${live};(0,eval)(new TextDecoder().decode(Uint8Array.from(atob("${b64}"),c=>c.charCodeAt(0))));"started"`,
);

// A stuck page script never reaches its own cleanup.
const RECOVER = `(async()=>{delete navigator.mediaDevices.getUserMedia;app.workspace.iterateAllLeaves(l=>{if(l.view?.file?.path?.startsWith("_vc-e2e/"))l.detach()});await app.plugins.disablePlugin("voice-context");await app.plugins.enablePlugin("voice-context");const f=app.vault.getAbstractFileByPath("_vc-e2e");if(f)await app.vault.delete(f,true)})();"recovering"`;

const deadline = Date.now() + 240_000;
let report: { done: boolean; results: { name: string; ok: boolean; detail?: string }[]; error?: string } | null = null;
while (Date.now() < deadline) {
	await Bun.sleep(1000);
	report = JSON.parse((await evalCode(`JSON.stringify(window.__vcE2E)`)) || "null");
	if (report?.done) break;
}
if (!report?.done) {
	console.error("timed out", JSON.stringify(report));
	await evalCode(RECOVER);
	process.exit(2);
}

for (const r of report.results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : `\n     ${r.detail}`}`);
const failed = report.results.filter((r) => !r.ok).length;
console.log(`\n${report.results.length - failed}/${report.results.length} passed`);
if (report.error) console.error(`aborted: ${report.error}`);
console.log(`dev:errors: ${await cli("dev:errors")}`);
process.exit(failed || report.error ? 1 : 0);
