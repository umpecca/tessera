// OSC 7: a shell reports its working directory as a file:// URL naming the
// machine it runs on. The pane takes the path as its working directory, which
// new terminals inherit and a restarted shell starts in, but only when the
// URL names the Tessera host: inside ssh, the shell reports a path on another
// machine.

const loopbackHosts = new Set(["", "localhost", "127.0.0.1", "[::1]"]);

function normalizeHost(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\.$/u, "");
}

// Names match whole or by their first label, so "studio" and
// "studio.local" are the same machine.
function isHost(reported, hostName) {
  const host = normalizeHost(reported);
  if (loopbackHosts.has(host)) {
    return true;
  }
  const own = normalizeHost(hostName);
  return Boolean(own) && (host === own || host.split(".")[0] === own.split(".")[0]);
}

// Returns the host path a report names, or "" for anything else: another
// machine, another scheme, a malformed URL.
export function terminalWorkingDirectory(report, hostName) {
  let url;
  try {
    url = new URL(report);
  } catch {
    return "";
  }
  if (url.protocol !== "file:" || !isHost(url.hostname, hostName)) {
    return "";
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
  // file:///C:/Users/me names C:/Users/me on a Windows host.
  if (/^\/[A-Za-z]:\//u.test(path)) {
    path = path.slice(1);
  }
  if (path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) {
    return "";
  }
  return path;
}
