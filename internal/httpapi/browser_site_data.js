// Stand-ins for localStorage, sessionStorage and document.cookie in a
// Browser pane (task 242). The page's origin is opaque, so the browser's own
// throw; Tessera keeps the data instead (browser_site_data.go). This runs
// before any of the page's scripts: it loads the page's data with one
// blocking request, answers reads from that copy, and sends changes back in
// a batch at the end of each task. The proxy appends the call with the state
// URL and the proxy prefix.
(function (stateURL, prefix) {
  "use strict";
  const NativeXHR = window.XMLHttpRequest;
  const nativeOpen = NativeXHR.prototype.open;
  const nativeFetch = window.fetch;
  const quota = 5 * 1024 * 1024;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const documentPath = () => location.pathname.slice(prefix.length) || "/";

  // A blocking request to the state URL, or null if it failed.
  const ask = (method, query, body) => {
    try {
      const request = new NativeXHR();
      nativeOpen.call(request, method, stateURL + query, false);
      if (body !== undefined) request.setRequestHeader("Content-Type", "text/plain");
      request.send(body);
      return request.status === 200 || request.status === 413 ? JSON.parse(request.responseText) : null;
    } catch (_) {
      return null;
    }
  };

  const snapshot = ask("GET", "?path=" + encodeURIComponent(documentPath())) || {};

  let pending = [];
  let scheduled = false;
  // Counts document.cookie writes, so an answer to an older batch doesn't
  // replace a newer copy.
  let cookieWrites = 0;
  let cookies = typeof snapshot.cookies === "string" ? snapshot.cookies : "";
  let cookiesStale = false;

  const bodyFor = (ops) => JSON.stringify({ path: documentPath(), ops });
  const answered = (data, writes) => {
    if (data && typeof data.error === "string") console.warn("Tessera Browser pane:", data.error);
    if (data && typeof data.cookies === "string" && writes === cookieWrites && !cookiesStale) cookies = data.cookies;
  };
  const flush = () => {
    scheduled = false;
    if (!pending.length) return;
    const body = bodyFor(pending);
    pending = [];
    const writes = cookieWrites;
    // keepalive lets a batch outlive the page, but browsers allow it only for
    // bodies up to 64 KiB.
    const keepalive = new TextEncoder().encode(body).length < 60000;
    nativeFetch.call(window, stateURL, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive })
      .then((response) => response.json())
      .then((data) => answered(data, writes))
      .catch(() => console.warn("Tessera Browser pane: storage changes were not saved"));
  };
  const queue = (op) => {
    pending.push(op);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };
  addEventListener("pagehide", flush);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  const quotaError = (key) => new DOMException(`Setting the value of '${key}' exceeded the quota.`, "QuotaExceededError");
  const length = (text) => text.length;

  // A Storage stand-in: the Storage methods, items as properties, and
  // Storage.prototype as its prototype, so instanceof Storage holds.
  const makeStorage = (name, initial) => {
    const items = Object.create(null);
    let size = 0;
    if (initial && typeof initial === "object") {
      for (const key of Object.keys(initial)) {
        items[key] = String(initial[key]);
        size += length(key) + length(items[key]);
      }
    }
    const has = (key) => own(items, key);
    const methods = {
      getItem(key) {
        key = String(key);
        return has(key) ? items[key] : null;
      },
      setItem(key, value) {
        key = String(key);
        value = String(value);
        if (has(key) && items[key] === value) return;
        const next = size - (has(key) ? length(key) + length(items[key]) : 0) + length(key) + length(value);
        if (next > quota) throw quotaError(key);
        size = next;
        items[key] = value;
        queue({ s: name, op: "set", k: key, v: value });
      },
      removeItem(key) {
        key = String(key);
        if (!has(key)) return;
        size -= length(key) + length(items[key]);
        delete items[key];
        queue({ s: name, op: "remove", k: key });
      },
      clear() {
        const keys = Object.keys(items);
        if (!keys.length) return;
        for (const key of keys) delete items[key];
        size = 0;
        queue({ s: name, op: "clear" });
      },
      key(index) {
        const keys = Object.keys(items);
        index = Math.trunc(Number(index)) || 0;
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
    };
    const builtIn = (key) => key === "length" || own(methods, key) || key in Object.prototype;
    return new Proxy(items, {
      get(target, key) {
        if (key === "length") return Object.keys(target).length;
        if (own(methods, key)) return methods[key];
        if (key === "constructor") return window.Storage;
        if (typeof key === "symbol") return key === Symbol.toStringTag ? "Storage" : undefined;
        if (key in Object.prototype) return Object.prototype[key];
        return has(key) ? target[key] : undefined;
      },
      set(target, key, value) {
        if (typeof key === "string" && !builtIn(key)) methods.setItem(key, value);
        return true;
      },
      defineProperty(target, key, descriptor) {
        if (typeof key === "string" && !builtIn(key) && "value" in descriptor) methods.setItem(key, descriptor.value);
        return true;
      },
      deleteProperty(target, key) {
        if (typeof key === "string") methods.removeItem(key);
        return true;
      },
      has(target, key) {
        return has(key) || (typeof window.Storage === "function" && key in window.Storage.prototype);
      },
      getPrototypeOf() {
        return typeof window.Storage === "function" ? window.Storage.prototype : Object.prototype;
      },
    });
  };

  for (const [name, store, initial] of [["localStorage", "local", snapshot.local], ["sessionStorage", "session", snapshot.session]]) {
    const storage = makeStorage(store, initial);
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => storage });
    } catch (_) {
      // The browser's own stays, and throws as before.
    }
  }

  // Updates the copy for a document.cookie write until Tessera answers with
  // the real result, which also applies paths and HttpOnly cookies.
  const applyCookie = (raw) => {
    const [pair, ...attributes] = raw.split(";");
    const equals = pair.indexOf("=");
    if (equals < 0) return;
    const name = pair.slice(0, equals).trim();
    if (!name) return;
    let removed = false;
    for (const attribute of attributes) {
      const [key, value = ""] = attribute.split("=");
      const lower = key.trim().toLowerCase();
      if (lower === "httponly") return;
      if (lower === "max-age" && Number(value) <= 0) removed = true;
      if (lower === "expires" && Date.parse(value) <= Date.now()) removed = true;
    }
    const kept = cookies ? cookies.split("; ").filter((cookie) => cookie.split("=")[0] !== name) : [];
    if (!removed) kept.push(name + "=" + pair.slice(equals + 1).trim());
    cookies = kept.join("; ");
  };
  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      enumerable: true,
      get() {
        if (cookiesStale) {
          // A response set cookies: send any waiting changes, blocking, and
          // read back the result.
          cookiesStale = false;
          const ops = pending;
          pending = [];
          const data = ops.length ? ask("POST", "", bodyFor(ops)) : ask("GET", "?part=cookies&path=" + encodeURIComponent(documentPath()));
          if (data && typeof data.cookies === "string") cookies = data.cookies;
        }
        return cookies;
      },
      set(value) {
        value = String(value);
        cookieWrites += 1;
        applyCookie(value);
        queue({ s: "cookie", v: value });
      },
    });
  } catch (_) {
    // The browser's own stays, and throws as before.
  }

  // Responses that set cookies say so, so the next read fetches them.
  const markStale = (response) => {
    if (response.headers.get("X-Tessera-Cookies")) cookiesStale = true;
    return response;
  };
  window.fetch = function (input, init) {
    return nativeFetch.call(window, input, init).then(markStale);
  };
  const watched = new WeakSet();
  NativeXHR.prototype.open = function () {
    if (!watched.has(this)) {
      watched.add(this);
      this.addEventListener("readystatechange", () => {
        if (this.readyState === NativeXHR.HEADERS_RECEIVED && this.getResponseHeader("X-Tessera-Cookies")) cookiesStale = true;
      });
    }
    return nativeOpen.apply(this, arguments);
  };
})
