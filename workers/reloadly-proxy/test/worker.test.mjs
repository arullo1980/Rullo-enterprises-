/**
 * Worker tests — run with `npm test`. No wrangler, no network, no credentials.
 *
 * The Worker's fetch handler is a plain function over standard Request/Response,
 * so Node can drive it directly. Everything here runs in mock mode; the point is
 * to prove the routing, validation, CORS, and cache rules are right before the
 * real Reloadly credentials ever exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

var MOCK = { RELOADLY_ENV: "mock" };
var SITE = "https://rulloenterprises.com";

function call(path, opts) {
  opts = opts || {};
  var headers = {};
  if (opts.origin) headers.Origin = opts.origin;
  var req = new Request("https://proxy.test" + path, {
    method: opts.method || "GET",
    headers: headers,
  });
  return worker.fetch(req, opts.env || MOCK);
}

async function body(res) {
  return JSON.parse(await res.text());
}

test("health reports mode and whether credentials are present", async () => {
  var res = await call("/health");
  assert.equal(res.status, 200);
  var data = await body(res);
  assert.equal(data.ok, true);
  assert.equal(data.mode, "mock");
  assert.equal(data.credentials, false);
});

test("operators returns shaped mock data for a known country", async () => {
  var data = await body(await call("/operators?country=NG"));
  assert.equal(data.country, "NG");
  assert.equal(data.count, 4);
  assert.equal(data.operators[0].name, "MTN Nigeria");
});

test("country code is normalised to uppercase", async () => {
  var data = await body(await call("/operators?country=ng"));
  assert.equal(data.country, "NG");
  assert.equal(data.count, 4);
});

test("each catalog category has its own route", async () => {
  var gift = await body(await call("/giftcards?country=MX"));
  assert.equal(gift.count, 3);
  assert.equal(gift.giftcards[1].brand, "Netflix");

  var util = await body(await call("/utilities?country=NG"));
  assert.equal(util.count, 3);
  assert.equal(util.utilities[0].type, "ELECTRICITY_BILL_PAYMENT");
});

test("coverage rolls every category into one response", async () => {
  var data = await body(await call("/coverage?country=NG"));
  assert.equal(data.reachable, true);
  assert.deepEqual(Object.keys(data.categories), ["operators", "data", "giftcards", "utilities"]);
  assert.equal(data.categories.giftcards.count, 2);
  assert.equal(data.categories.utilities.count, 3);
  assert.ok(data.categories.operators.sample.length <= 6);
});

test("airtime and data are counted separately, not double-counted", async () => {
  // NG fixtures: 4 operators, of which exactly one is a data bundle.
  var data = await body(await call("/coverage?country=NG"));
  assert.equal(data.categories.operators.count, 3);
  assert.equal(data.categories.data.count, 1);
  assert.deepEqual(data.categories.data.sample, ["Glo Nigeria Data"]);
  assert.ok(!data.categories.operators.sample.includes("Glo Nigeria Data"));
});

test("a country with no data bundles reports data as zero, not absent", async () => {
  var data = await body(await call("/coverage?country=MX"));
  assert.equal(data.categories.data.available, true);
  assert.equal(data.categories.data.count, 0);
  assert.equal(data.categories.operators.count, 3);
});

test("a country with no coverage is reachable:false, not an error", async () => {
  var res = await call("/coverage?country=ZW");
  assert.equal(res.status, 200);
  var data = await body(res);
  assert.equal(data.reachable, false);
  assert.equal(data.categories.operators.available, true);
  assert.equal(data.categories.operators.count, 0);
});

test("countries lists destinations", async () => {
  var data = await body(await call("/countries"));
  assert.equal(data.count, 3);
  assert.equal(data.countries[0].iso, "NG");
});

test("a bad country code is rejected and never cached", async () => {
  var bad = ["", "?country=", "?country=Z", "?country=123", "?country=N1",
             "?country=ZZZ", "?country=NGA", "?country=%20%20"];
  for (var q of bad) {
    var res = await call("/operators" + q);
    assert.equal(res.status, 400, "expected 400 for " + JSON.stringify(q));
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }
});

test("successful responses are cacheable for an hour", async () => {
  var res = await call("/operators?country=NG");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
});

test("unknown paths 404 and trailing slashes are tolerated", async () => {
  assert.equal((await call("/nope")).status, 404);
  assert.equal((await call("/health/")).status, 200);
});

test("non-GET methods are rejected", async () => {
  var res = await call("/operators?country=NG", { method: "POST" });
  assert.equal(res.status, 405);
});

test("CORS echoes the site origin but not an unknown one", async () => {
  var allowed = await call("/health", { origin: SITE });
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), SITE);

  var evil = await call("/health", { origin: "https://attacker.example" });
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);

  // No Origin at all (curl, the test script) is fine — CORS simply doesn't apply.
  var direct = await call("/health");
  assert.equal(direct.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(direct.status, 200);
});

test("extra origins can be added by config without a code change", async () => {
  var env = { RELOADLY_ENV: "mock", ALLOWED_ORIGINS: "http://localhost:8080, https://arullo1980.github.io" };
  var res = await call("/health", { origin: "http://localhost:8080", env: env });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:8080");
});

test("preflight returns 204 with the allow headers", async () => {
  var res = await call("/operators", { method: "OPTIONS", origin: SITE });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
  assert.equal(res.headers.get("Vary"), "Origin");
});

test("without credentials a live call fails closed as 503, leaking nothing", async () => {
  var res = await call("/operators?country=NG", { env: { RELOADLY_ENV: "sandbox" } });
  assert.equal(res.status, 503);
  var data = await body(res);
  assert.equal(data.error, "proxy not configured");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("coverage degrades per-category instead of failing whole", async () => {
  // sandbox with no credentials: every category rejects, so all are unavailable
  // but the response itself still succeeds.
  var res = await call("/coverage?country=NG", { env: { RELOADLY_ENV: "sandbox" } });
  assert.equal(res.status, 200);
  var data = await body(res);
  assert.equal(data.reachable, false);
  assert.equal(data.categories.giftcards.available, false);
  assert.equal(data.categories.data.available, false);
});
