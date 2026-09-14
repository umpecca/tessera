const policy = TesseraClipboardPolicy;
const enabled = document.querySelector("#enabled");
const terminal = document.querySelector("#terminal");
const save = document.querySelector("#save");
const status = document.querySelector("#status");
let origin;

async function render() {
  const { sites = {} } = await browser.storage.local.get("sites");
  enabled.checked = Boolean(origin && Object.hasOwn(sites, origin));
  terminal.checked = enabled.checked && sites[origin].terminal === true;
  enabled.disabled = !origin;
  terminal.disabled = !enabled.checked;
  save.disabled = !origin;
  const list = document.querySelector("#sites");
  list.replaceChildren();
  for (const address of Object.keys(sites).sort()) {
    const item = document.createElement("li");
    item.append(document.createTextNode(address));
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      try {
        await browser.runtime.sendMessage({ operation: "configure", origin: address, enabled: false });
        await render();
        status.textContent = "Address removed. Clipboard access is disabled.";
      } catch (error) { status.textContent = error.message; }
    });
    item.append(remove);
    list.append(item);
  }
}
enabled.addEventListener("change", () => { terminal.disabled = !enabled.checked; });
save.addEventListener("click", async () => {
  try {
    // Request directly from the click handler to preserve Firefox activation.
    if (enabled.checked && !await browser.permissions.request({ origins: [policy.pattern(origin)] })) {
      throw new Error("Site permission was declined.");
    }
    save.disabled = true;
    await browser.runtime.sendMessage({ operation: "configure", origin, enabled: enabled.checked, terminal: terminal.checked });
    await render();
    status.textContent = "Saved. Return to Tessera and click Check connection in Settings → Clipboard.";
  } catch (error) { status.textContent = error.message; save.disabled = !origin; }
});
void (async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  origin = policy.origin(tab?.url);
  document.querySelector("#origin").textContent = origin || "Open your Tessera page first.";
  await render();
})().catch(error => { status.textContent = error.message; });
