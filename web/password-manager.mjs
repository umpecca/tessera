// Offers a login that worked to the browser's password manager, where the
// browser has the Credential Management API (Chrome, Edge). Other browsers go
// by the sign-in form's submission, which a page that signs in without
// navigating can't count on. Browsers keep logins per website, so `name` says
// what the login is for. Resolves whether it was offered.
export async function offerLoginToBrowser({ username, password, name }, env = globalThis) {
  if (!username || !password || typeof env.PasswordCredential !== "function" || typeof env.navigator?.credentials?.store !== "function") {
    return false;
  }
  try {
    await env.navigator.credentials.store(new env.PasswordCredential({ id: username, password, name: name || username }));
    return true;
  } catch {
    return false;
  }
}
