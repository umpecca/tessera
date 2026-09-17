export function isIPadOSDevice({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  if (/ipad/i.test(String(userAgent))) return true;
  return /^MacIntel$/i.test(String(platform)) && Number(maxTouchPoints) > 1;
}

export function shouldShowIPadHTTPGuidance({ protocol, device, dismissed = false } = {}) {
  return protocol === "http:" && isIPadOSDevice(device) && !dismissed;
}
