// Classic, parser-blocking script: the cached theme must precede CSS and paint.
// Keep this independent of the app's module graph and its network requests.
(() => {
  const root = document.documentElement;
  const themeIDs = ["next-tessera", "studio", "hacker", "dark-professional", "oled-terminal", "operator"];
  const cacheKey = user => `tessera.theme.v1.${encodeURIComponent(user)}`;
  try {
    const route = location.pathname.match(/^\/users\/([^/]+)\/sessions\/[^/]+\/?$/);
    const user = route ? decodeURIComponent(route[1]) : localStorage.getItem("tessera-user") || "default";
    const theme = localStorage.getItem(cacheKey(user));
    if (themeIDs.includes(theme)) root.dataset.theme = theme;
  } catch {
    // Private browsing, unavailable storage, and malformed routes are harmless.
  }

  const timeout = setTimeout(() => fail("Opening Tessera is taking longer than expected. You can reload to try again."), 15000);

  function fail(message = "Tessera could not open your workspace. Please reload to try again.") {
    root.dataset.startup = "error";
    const status = document.getElementById("startup-message");
    if (status) status.textContent = message;
    const reload = document.getElementById("startup-reload");
    if (reload) reload.hidden = false;
  }

  window.tesseraStartup = {
    cacheTheme(user, theme) {
      if (!user || !themeIDs.includes(theme)) return;
      try { localStorage.setItem(cacheKey(user), theme); } catch {}
    },
    finish() {
      clearTimeout(timeout);
      delete root.dataset.startup;
      const shell = document.getElementById("startup");
      if (shell) shell.hidden = true;
      const board = document.getElementById("board");
      board?.removeAttribute("inert");
      board?.removeAttribute("aria-busy");
    },
    fail,
  };
})();
