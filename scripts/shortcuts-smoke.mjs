// Real modal, palette/wheel, server and PTY. Optional --playwright=<module>.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(arg("output", ".cache/review/shortcuts-174"));
await mkdir(output, { recursive: true });
const modulePath = arg("playwright", "playwright");
const { chromium, firefox } = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
const ext = process.platform === "win32" ? ".exe" : "";
const serverBinary = path.join(output, "tessera-smoke" + ext), probe = path.join(output, "probe" + ext);
const probeSource = path.join(output, "probe.go");
await writeFile(probeSource, `package main
import("encoding/json";"os";"fmt")
func main(){cwd,_:=os.Getwd(); data,_:=json.Marshal(map[string]any{"args":os.Args[1:],"cwd":cwd}); f,_:=os.OpenFile("launches.jsonl",os.O_CREATE|os.O_APPEND|os.O_WRONLY,0600); if f!=nil{f.Write(append(data,'\\n'));f.Close()}; fmt.Println("SHORTCUT_PROBE="+string(data))}
`);
for (const [file, command] of [[serverBinary, "./cmd/tessera"], [probe, probeSource]]) {
  const result = spawnSync("go", ["build", "-o", file, command], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}
const host = spawn(serverBinary, ["-addr", "127.0.0.1:0", "-db", path.join(output, `smoke-${Date.now()}.db`), "-tray=false", "-web", path.join(root, "web")], { cwd: root, windowsHide: true });
let log = "";
const baseURL = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("host startup timed out: " + log)), 20000);
  const receive = data => { log += data; const match = log.match(/Tessera listening at (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } };
  host.stdout.on("data", receive); host.stderr.on("data", receive); host.once("error", reject);
});
const source = await readFile(path.join(root, "web/app.js"), "utf8");
const instrumentation = `
window.shortcutSmoke = {
 ready: () => Boolean(currentSessionID) && !isLoadingWorkspace,
 items: () => structuredClone(shortcutsUI.items),
 active: () => getActivePane()?.id,
 count: () => rectangles.filter(p=>p.kind==='terminal').length,
 save: () => flushAllPersistence(),
 user: () => currentUser,
};`;
const quote = v => "'" + v.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
const command = (process.platform === "win32" ? "& " : "") + quote(probe);
let browser, page; const results = [];
const readLaunches = async directory => {
  try { return (await readFile(path.join(directory, "launches.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
async function waitLaunch(directory, count) {
  for (let i = 0; i < 200; i++) { const launches = await readLaunches(directory); if (launches.length >= count) return launches; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error("terminal command did not run");
}
try {
  for (const name of arg("browsers", "chrome,edge,firefox").split(",")) {
    browser = await (name === "firefox" ? firefox : chromium).launch({ headless: true, ...(name === "chrome" ? { channel: "chrome" } : name === "edge" ? { channel: "msedge" } : {}) });
    const context = await browser.newContext(); page = await context.newPage(); const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await context.route("**/app.js*", route => route.fulfill({ status: 200, contentType: "text/javascript", body: source + instrumentation }));
    await page.goto(baseURL); await page.waitForFunction(() => window.shortcutSmoke?.ready());
    const user = await page.evaluate(() => window.shortcutSmoke.user());
    const endpoint = `${baseURL}/api/users/${encodeURIComponent(user)}/shortcuts`;
    const existing = await (await fetch(endpoint)).json();
    assert.equal((await fetch(endpoint, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({revision:existing.revision,shortcuts:[]}) })).status,200);
    await page.reload(); await page.waitForFunction(() => window.shortcutSmoke?.ready());
    const modal = page.locator(".shortcuts-modal");
    const palette = async code => { await page.keyboard.press("Control+k"); await page.locator(".command-palette-input").first().fill(code); await page.keyboard.press("Enter"); };
    await palette("CS"); await modal.getByRole("button", { name:"Add shortcut", exact:true }).click();
    const directory = path.join(output, `${name}-${Date.now()}`); await mkdir(directory,{recursive:true});
    await modal.getByLabel("Name",{exact:true}).fill("Editor");
    await modal.getByLabel("Palette code",{exact:true}).fill("CE");
    await modal.getByLabel("Base command",{exact:true}).fill(command);
    await modal.getByLabel("Working directory",{exact:true}).fill(directory);
    async function addInput(label, flag, type="text", defaultValue="") {
      await modal.getByRole("button",{name:"Add input",exact:true}).click();
      let row = modal.locator(".shortcut-input-row").last();
      await row.getByLabel("Input label",{exact:true}).fill(label);
      if(type!=="text") await row.getByLabel("Input type",{exact:true}).selectOption(type);
      row = modal.locator(".shortcut-input-row").last();
      await row.getByLabel("CLI switch",{exact:true}).fill(flag);
      if(type==="boolean") await row.getByLabel("Checked by default").check();
      else await row.getByLabel("Default value",{exact:true}).fill(defaultValue);
    }
    await addInput("File","--file"); await addInput("Read only","--readonly","boolean"); await addInput("Extra","","text","fallback");
    await page.screenshot({path:path.join(output,`${name}-manager.png`)});
    await modal.getByRole("button",{name:"Save shortcut",exact:true}).click();
    await modal.getByRole("button",{name:"CE · Editor",exact:true}).waitFor();
    await modal.getByRole("button",{name:"Close shortcuts"}).click();
    const count = await page.evaluate(()=>window.shortcutSmoke.count());
    await palette("CE");
    const literal = "notes 世界 O'Brien; $HOME.txt";
    await modal.getByLabel("File (optional)",{exact:true}).fill(literal);
    await modal.getByLabel("Read only (optional)",{exact:true}).uncheck();
    await page.screenshot({path:path.join(output,`${name}-invocation.png`)});
    await modal.getByRole("button",{name:"Launch",exact:true}).click();
    const first = (await waitLaunch(directory,1))[0];
    assert.deepEqual(first.args,["--file",literal,"fallback"]); assert.equal(first.cwd,directory);
    assert.equal(await page.evaluate(()=>window.shortcutSmoke.count()),count+1);
    await page.evaluate(()=>window.shortcutSmoke.save()); await page.reload(); await page.waitForFunction(()=>window.shortcutSmoke?.ready());
    // Restored terminals must not execute their old startup command again.
    await page.waitForTimeout(600); assert.equal((await readLaunches(directory)).length,1);
    await page.keyboard.press("Control+;"); await page.keyboard.press("c"); await page.keyboard.press("e");
    await modal.getByRole("button",{name:"Launch",exact:true}).waitFor();
    await modal.getByLabel("Extra (optional)",{exact:true}).fill("");
    await modal.getByRole("button",{name:"Launch",exact:true}).click();
    assert.deepEqual((await waitLaunch(directory,2))[1].args,["--readonly"]);
    await palette("CE"); await modal.getByRole("button",{name:"Cancel",exact:true}).click(); assert.equal((await readLaunches(directory)).length,2);
    await palette("CS"); await modal.locator(".shortcut-row").getByRole("button",{name:"Duplicate",exact:true}).click();
    await modal.getByLabel("Palette code",{exact:true}).fill("CF");
    await modal.getByRole("button",{name:"Save shortcut",exact:true}).click();
    await modal.getByRole("button",{name:"CF · Editor copy",exact:true}).waitFor();
    const items = await page.evaluate(()=>window.shortcutSmoke.items()); assert.equal(items.length,2); assert.notEqual(items[0].fields[0].id,undefined); assert.deepEqual(items[0].fields,items[1].fields);
    page.once("dialog",dialog=>dialog.accept());
    await modal.locator(".shortcut-row").filter({hasText:"CF · Editor copy"}).getByRole("button",{name:"Delete",exact:true}).click();
    await page.waitForFunction(()=>window.shortcutSmoke.items().length===1);
    await modal.getByRole("button",{name:"Add shortcut",exact:true}).click();
    await modal.getByLabel("Name",{exact:true}).fill("Probe"); await modal.getByLabel("Palette code",{exact:true}).fill("CP");
    await modal.getByLabel("Base command",{exact:true}).fill(command); await modal.getByLabel("Working directory",{exact:true}).fill(directory);
    await modal.getByRole("button",{name:"Test shortcut",exact:true}).click(); await waitLaunch(directory,3);
    assert.equal((await (await fetch(endpoint)).json()).shortcuts.length,1);
    await palette("CS"); assert.equal(await modal.getByLabel("Name",{exact:true}).inputValue(),"Probe");
    // Concurrent saves retain the draft and show a conflict, never overwrite.
    const concurrent = await (await fetch(endpoint)).json();
    assert.equal((await fetch(endpoint,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:concurrent.revision,shortcuts:concurrent.shortcuts})})).status,200);
    await modal.getByRole("button",{name:"Save shortcut",exact:true}).click(); await modal.getByRole("alert").filter({hasText:/reload/i}).waitFor();
    assert.equal(await modal.getByLabel("Name",{exact:true}).inputValue(),"Probe");
    page.once("dialog",dialog=>dialog.accept()); await modal.getByRole("button",{name:"Reload shortcuts",exact:true}).click();
    await modal.getByLabel("Name",{exact:true}).waitFor({state:"detached"}); assert.equal(await modal.getByLabel("Name",{exact:true}).count(),0);
    assert.deepEqual(errors,[]);
    results.push({browser:name,version:browser.version(),checks:["CRUD and duplicate","palette CE","wheel CE","literal CLI values and cwd","optional omission and boolean switches","new terminal","restore without rerun","cancel","draft test without save","concurrent conflict preserves draft"]});
    await context.close(); await browser.close(); browser=null;
  }
  await writeFile(path.join(output,"results.json"),JSON.stringify(results,null,2)); console.log(JSON.stringify(results,null,2));
} catch(error) { await page?.screenshot({path:path.join(output,"failure.png")}).catch(()=>{}); throw error; }
finally { await browser?.close(); host.kill(); await writeFile(path.join(output,"host.log"),log); }
