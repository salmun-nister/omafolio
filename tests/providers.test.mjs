import test from "node:test";
import assert from "node:assert/strict";
import { providerFor, quoteRequests, historyRequests, searchRequests, parse } from "../lib/providers/index.mjs";
import { ProviderError } from "../lib/types.mjs";

test("routing by prefix", () => {
  assert.equal(providerFor("crypto:bitcoin").id, "coingecko");
  assert.equal(providerFor("VOO").id, "yahoo");
  assert.equal(providerFor("crypto:").id, "coingecko");
  assert.equal(providerFor("CRYPTO").id, "yahoo");
  assert.equal(providerFor("xcrypto:bitcoin").id, "yahoo");
});

test("one request per provider for a mixed set", () => {
  const reqs = quoteRequests(["VOO", "crypto:bitcoin", "AAPL"]);
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map((r) => r.provider).sort(), ["coingecko", "yahoo"]);
  assert.deepEqual(reqs.find((r) => r.provider === "yahoo").assets, ["VOO", "AAPL"]);
});

test("an empty partition produces no request", () => {
  assert.deepEqual(quoteRequests([]), []);
  assert.deepEqual(quoteRequests(["VOO"]).map((r) => r.provider), ["yahoo"]);
  assert.deepEqual(quoteRequests(["crypto:bitcoin"]).map((r) => r.provider), ["coingecko"]);
});

test("a bare crypto: prefix is unknown and produces no request", () => {
  assert.deepEqual(quoteRequests(["crypto:"]), []);
  assert.deepEqual(historyRequests(["crypto:"], "1W", () => undefined), []);
});

test("history asks CoinGecko in US dollars and passes kindOf to Yahoo", () => {
  const kindOf = (a) => (a === "VTSAX" ? "fund" : undefined);
  const reqs = historyRequests(["VTSAX", "AAPL", "crypto:bitcoin"], "1D", kindOf);
  const cg = reqs.filter((r) => r.provider === "coingecko");
  const yh = reqs.filter((r) => r.provider === "yahoo");
  assert.equal(cg.length, 1);
  assert.match(cg[0].url, /vs_currency=usd&days=1$/);
  assert.equal(yh.length, 2);
  assert.ok(yh.some((r) => r.url.includes("range=5d&interval=1d") && r.assets.join() === "VTSAX"));
});

test("search fans out to both providers", () => {
  const reqs = searchRequests("sol");
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map((r) => r.provider).sort(), ["coingecko", "yahoo"]);
});

test("parse dispatches on request.provider", () => {
  const cg = searchRequests("sol").find((r) => r.provider === "coingecko");
  assert.deepEqual(parse(cg, 200, JSON.stringify({ coins: [{ id: "solana", name: "Solana", symbol: "SOL" }] })).map((r) => r.asset), ["crypto:solana"]);
  const yh = searchRequests("sol").find((r) => r.provider === "yahoo");
  assert.deepEqual(parse(yh, 200, JSON.stringify({ quotes: [] })), []);
  assert.throws(() => parse(cg, 429, "{}"), ProviderError);
});

test("parse throws ProviderError for an unknown provider", () => {
  assert.throws(() => parse({ provider: "nope", type: "quotes", url: "", assets: [] }, 200, "[]"), ProviderError);
});

test("cash routes to Yahoo, whose rates price it, but is never put in a request", () => {
  assert.equal(providerFor("cash:EUR").id, "yahoo");
  assert.deepEqual(quoteRequests(["cash:EUR"]), []);
  assert.deepEqual(historyRequests(["cash:EUR"], "1M", () => undefined), []);
  assert.deepEqual(quoteRequests(["cash:EUR", "VOO"])[0].assets, ["VOO"]);
});
