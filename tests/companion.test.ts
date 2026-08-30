import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPANION_PORT,
  encodePairingUrl,
  isPairingUrl,
  normalizePairingCode,
  parseCompanionOrigin,
  parsePairingUrl,
  pairingUrlFromStatus,
} from "../src/companion.ts";

test("parses hostnames, Tailscale names, and IP addresses", () => {
  assert.equal(
    parseCompanionOrigin("macbook-pro.local"),
    `http://macbook-pro.local:${DEFAULT_COMPANION_PORT}`,
  );
  assert.equal(
    parseCompanionOrigin("100.64.1.20"),
    `http://100.64.1.20:${DEFAULT_COMPANION_PORT}`,
  );
  assert.equal(
    parseCompanionOrigin("james-mbp.tailnet.ts.net"),
    `http://james-mbp.tailnet.ts.net:${DEFAULT_COMPANION_PORT}`,
  );
  assert.equal(
    parseCompanionOrigin("http://192.168.1.12:7420"),
    "http://192.168.1.12:7420",
  );
  assert.equal(
    parseCompanionOrigin("192.168.1.12:9000"),
    "http://192.168.1.12:9000",
  );
});

test("keeps an explicit port and strips paths", () => {
  assert.equal(
    parseCompanionOrigin("http://macbook.local:7420/v1/catalog"),
    "http://macbook.local:7420",
  );
});

test("rejects empty and non-network URLs", () => {
  assert.throws(() => parseCompanionOrigin(""), /address or Tailscale/);
  assert.throws(() => parseCompanionOrigin("ftp://macbook.local"), /HTTP or HTTPS/);
});

test("pairing codes ignore hyphens and case", () => {
  assert.equal(normalizePairingCode("k7m2-q9xp"), "K7M2Q9XP");
  assert.equal(normalizePairingCode("  ABCD 2345 "), "ABCD2345");
});

test("pairing URLs round-trip token and hosts", () => {
  const url = encodePairingUrl("k7m2-q9xp", [
    "http://192.168.1.12:7420",
    "http://100.64.1.20:7420",
    "macbook.local",
  ]);
  assert.match(url, /^codebase-atlas:\/\/pair\?/);
  const parsed = parsePairingUrl(url);
  assert.equal(parsed.token, "K7M2Q9XP");
  assert.deepEqual(parsed.origins, [
    "http://192.168.1.12:7420",
    "http://100.64.1.20:7420",
    `http://macbook.local:${DEFAULT_COMPANION_PORT}`,
  ]);
});

test("pairing URL from share status skips loopback when a LAN address exists", () => {
  const url = pairingUrlFromStatus({
    token: "ABCD-2345",
    addresses: [
      { url: "http://127.0.0.1:7420", label: "loopback", kind: "loopback" },
      { url: "http://192.168.4.121:7420", label: "wifi", kind: "lan" },
    ],
  });
  const parsed = parsePairingUrl(url);
  assert.equal(parsed.token, "ABCD2345");
  assert.deepEqual(parsed.origins, ["http://192.168.4.121:7420"]);
  assert.equal(isPairingUrl(url), true);
  assert.equal(isPairingUrl("http://192.168.4.121:7420"), false);
});

test("rejects pairing URLs without a token or host", () => {
  assert.throws(() => parsePairingUrl("https://example.com"), /not a Codebase Atlas pairing/);
  assert.throws(() => parsePairingUrl("codebase-atlas://pair?t=ABCD2345"), /missing a host/);
});
