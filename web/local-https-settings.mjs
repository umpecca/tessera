export function splitLocalHTTPSNames(value) {
  return [...new Set(String(value || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

export function localHTTPSConfigWithCurrentHostname(config, hostname) {
  const currentHostname = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  const unwrappedHostname = currentHostname.replace(/^\[|\]$/g, "");
  if (!currentHostname || currentHostname === "localhost" || currentHostname.endsWith(".localhost") || isIPAddress(unwrappedHostname)) {
    return config;
  }
  const dnsNames = splitLocalHTTPSNames(config?.dnsNames || []);
  if (dnsNames.some((name) => name.toLowerCase() === currentHostname)) {
    return config;
  }
  return { ...config, dnsNames: [currentHostname, ...dnsNames] };
}

function isIPAddress(hostname) {
  if (hostname.includes(":")) return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

export function localHTTPSDraft(form) {
  return {
    enabled: Boolean(form.enabled),
    httpsAddress: String(form.httpsAddress || "").trim(),
    dnsNames: splitLocalHTTPSNames(form.dnsNames),
    ipAddresses: splitLocalHTTPSNames(form.ipAddresses),
  };
}

export function validateLocalHTTPSDraft(config) {
  if (!config.enabled) return "";
  if (!config.httpsAddress || !config.httpsAddress.includes(":")) {
    return "Enter the HTTPS listener as host:port.";
  }
  if (config.dnsNames.length === 0 && config.ipAddresses.length === 0) {
    return "Add at least one DNS name or IP address used to open Tessera.";
  }
  return "";
}

export function localHTTPSNextURL(response, currentURL) {
  if (response?.config?.enabled) {
    return response.enrollmentURL || response.httpsURL || currentURL;
  }
  return response?.httpURL || currentURL;
}
