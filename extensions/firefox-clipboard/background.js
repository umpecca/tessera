const policy = TesseraClipboardPolicy;
const registrations = [];
let registrationWork = Promise.resolve();

async function refreshRegistrations() {
  for (const registration of registrations.splice(0)) await registration.unregister();
  const { sites = {} } = await browser.storage.local.get("sites");
  const patterns = [...new Set(Object.keys(sites).map(origin => policy.pattern(origin)))];
  for (const pattern of patterns) {
    if (!await browser.permissions.contains({ origins: [pattern] })) continue;
    registrations.push(await browser.contentScripts.register({
      matches: [pattern], allFrames: false, runAt: "document_start",
      js: [{ file: "content.js" }],
    }));
    // Enable already-open tabs as well as future navigations. The script is
    // idempotent; exact-origin authorization remains in the background.
    for (const tab of await browser.tabs.query({ url: pattern })) {
      await browser.tabs.executeScript(tab.id, { file: "content.js", frameId: 0 }).catch(() => {});
    }
  }
}

function scheduleRegistrationRefresh() {
  registrationWork = registrationWork.catch(() => {}).then(refreshRegistrations);
  return registrationWork;
}

// Keep clipboard contents in the extension's own DOM. Page paste handlers and
// page scripts cannot intercept this field or interfere with execCommand.
function clipboardText(operation, text) {
  const field = document.createElement("textarea");
  field.style.cssText = "position:fixed;left:-10000px;top:0";
  field.value = text || "";
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand(operation === "read" ? "paste" : "copy")) {
      throw new Error("Firefox refused clipboard access. Use keyboard copy/paste.");
    }
    if (operation === "read" && field.value.length > policy.maxTextLength) {
      throw new Error("Clipboard text exceeds the 1 MiB character limit.");
    }
    return operation === "read" ? field.value : "";
  } finally { field.remove(); }
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;
  if (message?.operation === "configure") {
    // Only the packaged popup can grant/revoke an origin; content scripts
    // cannot promote requests from a web page into configuration changes.
    if (sender.tab || sender.url !== browser.runtime.getURL("popup.html")) return undefined;
    const origin = policy.origin(message.origin);
    if (!origin || origin !== message.origin) throw new Error("Invalid Tessera address.");
    const { sites = {} } = await browser.storage.local.get("sites");
    if (message.enabled) {
      if (!await browser.permissions.contains({ origins: [policy.pattern(origin)] })) {
        throw new Error("Site permission was not granted.");
      }
      sites[origin] = { terminal: message.terminal === true };
    } else {
      delete sites[origin];
    }
    await browser.storage.local.set({ sites });
    await scheduleRegistrationRefresh();
    return { ok: true };
  }
  const { sites = {} } = await browser.storage.local.get("sites");
  if (!policy.allowed(message, sender, sites)) return { ok: false, error: "Clipboard bridge is not enabled for this request." };
  if (!await browser.permissions.contains({ origins: [policy.pattern(policy.origin(sender.url))] })) {
    return { ok: false, error: "Site permission was removed." };
  }
  if (message.operation === "hello") {
    return { ok: true, version: browser.runtime.getManifest().version, terminal: sites[policy.origin(sender.url)].terminal };
  }
  try { return { ok: true, text: clipboardText(message.operation, message.text) }; }
  catch (error) { return { ok: false, error: error.message }; }
});

browser.permissions.onRemoved.addListener(() => { void scheduleRegistrationRefresh().catch(console.error); });
void scheduleRegistrationRefresh().catch(console.error);
