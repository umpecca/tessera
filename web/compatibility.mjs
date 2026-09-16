function positiveScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function formatScale(value) {
  return `${Number(value.toFixed(2))}×`;
}

export function browserName(userAgent = "") {
  const candidates = [
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Edge", /Edg\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari\//],
  ];
  for (const [name, pattern] of candidates) {
    const match = String(userAgent).match(pattern);
    if (match) return `${name} ${match[1]}`;
  }
  return "Unknown browser";
}

export function detectCompatibility({
  userAgent = "",
  platform = "Unknown",
  secureContext = false,
  clipboard = null,
  extension = null,
  displayPixelRatio = 1,
  olderMacMode = false,
  experimentalTerminalRenderer = false,
  online = true,
  serverHealthy = null,
  serverState = "",
} = {}) {
  const displayScale = positiveScale(displayPixelRatio);
  const renderScale = olderMacMode ? Math.min(displayScale, 1) : displayScale;
  const nativeClipboard = Boolean(
    secureContext
    && clipboard
    && typeof clipboard.readText === "function"
    && typeof clipboard.writeText === "function"
  );
  let connection = "Checking";
  if (!online || serverState === "offline") connection = "Browser offline";
  else if (serverHealthy === true || serverState === "restored") connection = "Connected";
  else if (serverHealthy === false || serverState === "unreachable") connection = "Tessera unreachable";

  return {
    browser: browserName(userAgent),
    platform: String(platform || "Unknown"),
    secureContext: Boolean(secureContext),
    nativeClipboard,
    extension: extension ? `Connected (v${extension.version || "unknown"})` : "Not connected",
    terminalClipboard: extension ? (extension.terminal ? "Enabled" : "Disabled") : "Extension unavailable",
    performanceProfile: olderMacMode ? "Older Mac" : "Standard",
    terminalRenderer: experimentalTerminalRenderer ? "Experimental" : "Stable",
    displayScale: formatScale(displayScale),
    renderScale: formatScale(renderScale),
    renderScaleDetail: olderMacMode && renderScale < displayScale ? `Capped from ${formatScale(displayScale)}` : "Native display scale",
    online: Boolean(online),
    connection,
  };
}

export function compatibilityDiagnostics(info) {
  return [
    "Tessera compatibility diagnostics",
    `Browser: ${info.browser}`,
    `Platform: ${info.platform}`,
    `Secure context: ${info.secureContext ? "Yes" : "No"}`,
    `Native clipboard API: ${info.nativeClipboard ? "Available" : "Unavailable"}`,
    `Clipboard extension: ${info.extension}`,
    `Terminal clipboard writes: ${info.terminalClipboard}`,
    `Performance profile: ${info.performanceProfile}`,
    `Terminal renderer: ${info.terminalRenderer}`,
    `Painting limit: ${info.performanceProfile === "Older Mac" ? "30 FPS; input temporarily bypasses cap" : "Display refresh rate"}`,
    "Renderer row paths:",
    ...(info.rendererRows || ["Not collected"]),
    "Rendering costs (CPU paint time; recent rates use the last 5 seconds):",
    ...(info.renderingCosts || []),
    `Display pixel ratio: ${info.displayScale}`,
    `Terminal render ratio: ${info.renderScale} (${info.renderScaleDetail})`,
    `Browser network: ${info.online ? "Online" : "Offline"}`,
    `Tessera connection: ${info.connection}`,
  ].join("\n");
}
