import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  localHTTPSConfigWithCurrentHostname,
  localHTTPSDraft,
  localHTTPSNextURL,
  splitLocalHTTPSNames,
  validateLocalHTTPSDraft,
} from "./local-https-settings.mjs";

test("prefills the current DNS hostname without replacing saved names", () => {
  const config = { dnsNames: ["saved.example.test"] };
  assert.deepEqual(localHTTPSConfigWithCurrentHostname(config, "Tessera.Home.Arpa"), {
    dnsNames: ["tessera.home.arpa", "saved.example.test"],
  });
  assert.deepEqual(config, { dnsNames: ["saved.example.test"] });
});

test("does not prefill IP literals, localhost, or an existing hostname", () => {
  const config = { dnsNames: ["tessera.home.arpa"] };
  assert.equal(localHTTPSConfigWithCurrentHostname(config, "tessera.home.arpa"), config);
  assert.equal(localHTTPSConfigWithCurrentHostname(config, "localhost"), config);
  assert.equal(localHTTPSConfigWithCurrentHostname(config, "192.168.1.20"), config);
  assert.equal(localHTTPSConfigWithCurrentHostname(config, "[fd7a:115c:a1e0::1]"), config);
});

test("splits and de-duplicates certificate names", () => {
  assert.deepEqual(splitLocalHTTPSNames("tessera.local, localhost\ntessera.local"), ["tessera.local", "localhost"]);
});

test("builds and validates an enabled Local HTTPS draft", () => {
  const draft = localHTTPSDraft({
    enabled: true,
    httpsAddress: " 0.0.0.0:7332 ",
    dnsNames: "tessera.local",
    ipAddresses: "192.168.1.20",
  });
  assert.equal(validateLocalHTTPSDraft(draft), "");
  assert.equal(draft.httpsAddress, "0.0.0.0:7332");
});

test("requires a certificate identity", () => {
  const noNames = localHTTPSDraft({ enabled: true, httpsAddress: "0.0.0.0:7331" });
  assert.match(validateLocalHTTPSDraft(noNames), /DNS name or IP/);
  noNames.dnsNames = ["tessera.local"];
});

test("chooses enrollment, HTTPS, or HTTP after a restart", () => {
  assert.equal(localHTTPSNextURL({ config: { enabled: true }, enrollmentURL: "http://setup/", httpsURL: "https://app/" }, "http://old/"), "http://setup/");
  assert.equal(localHTTPSNextURL({ config: { enabled: true }, httpsURL: "https://app/" }, "http://old/"), "https://app/");
  assert.equal(localHTTPSNextURL({ config: { enabled: false }, httpURL: "http://app/" }, "https://old/"), "http://app/");
});

test("the command palette opens the Local HTTPS modal and saves host settings", () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(source, /id: "local-https", label: "Local HTTPS\.\.\."/);
  assert.match(source, /function renderLocalHTTPSModal\(/);
  assert.match(source, /fetch\("\/api\/host\/https", \{/);
  assert.match(source, /Saving host settings and preparing certificates/);
  assert.match(source, /enrollment\.textContent = "Open HTTP enrollment page"/);
  assert.match(source, /enrollment\.target = "_blank"/);
  assert.match(source, /window\.open\("about:blank", "tessera-enrollment"\)/);
  assert.match(source, /identityTitle\.textContent = state\.rootName/);
});
