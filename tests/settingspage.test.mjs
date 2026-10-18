import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moveItem, withItem, withoutItem, toggleItem, parseAmount, snapSeconds, settingsEntry, kindLabel, itemLabel,
  displayPath, parentDir, PORTFOLIO_ITEM,
} from "../lib/settingspage.mjs";

const BAR = ["crypto:bitcoin", "portfolio", "VOO", "VTSAX"];

test("moveItem moves down and up and leaves the input alone", () => {
  assert.deepEqual(moveItem(BAR, 0, 2), ["portfolio", "VOO", "crypto:bitcoin", "VTSAX"]);
  assert.deepEqual(moveItem(BAR, 3, 0), ["VTSAX", "crypto:bitcoin", "portfolio", "VOO"]);
  assert.deepEqual(moveItem(BAR, 1, 1), BAR);
  assert.deepEqual(BAR, ["crypto:bitcoin", "portfolio", "VOO", "VTSAX"]);
});

test("moveItem clamps both ends: last index kept, one past lands on the end", () => {
  assert.deepEqual(moveItem(BAR, 0, 3), ["portfolio", "VOO", "VTSAX", "crypto:bitcoin"]);
  assert.deepEqual(moveItem(BAR, 0, 4), ["portfolio", "VOO", "VTSAX", "crypto:bitcoin"]);
  assert.deepEqual(moveItem(BAR, 3, 0), moveItem(BAR, 3, -1));
  assert.deepEqual(moveItem(BAR, 9, 0), ["VTSAX", "crypto:bitcoin", "portfolio", "VOO"]);
  assert.deepEqual(moveItem([], 0, 1), []);
});

test("moveItem rounds a fractional drag target", () => {
  assert.deepEqual(moveItem(BAR, 0, 1.4), moveItem(BAR, 0, 1));
  assert.deepEqual(moveItem(BAR, 0, 1.6), moveItem(BAR, 0, 2));
});

test("withItem appends once; withoutItem removes every copy", () => {
  assert.deepEqual(withItem(["A"], "B"), ["A", "B"]);
  const same = ["A", "B"];
  const out = withItem(same, "A");
  assert.deepEqual(out, ["A", "B"]);
  assert.notEqual(out, same);
  assert.deepEqual(withoutItem(["A", "B", "A"], "A"), ["B"]);
  assert.deepEqual(withoutItem(["A"], "Z"), ["A"]);
});

test("toggleItem adds an absent item at the end and removes a present one", () => {
  assert.deepEqual(toggleItem(BAR, "NVDA"), BAR.concat(["NVDA"]));
  assert.deepEqual(toggleItem(BAR, "VOO"), ["crypto:bitcoin", "portfolio", "VTSAX"]);
  assert.deepEqual(toggleItem(toggleItem(BAR, "VOO"), "VOO"), ["crypto:bitcoin", "portfolio", "VTSAX", "VOO"]);
});

test("parseAmount reads plain decimals, separators and space", () => {
  assert.equal(parseAmount("12"), 12);
  assert.equal(parseAmount(" 30.512 "), 30.512);
  assert.equal(parseAmount("1,250.5"), 1250.5);
  assert.equal(parseAmount(".5"), 0.5);
  assert.equal(parseAmount("5."), 5);
});

test("parseAmount boundary: 0 accepted, anything negative refused", () => {
  assert.equal(parseAmount("0"), 0);
  assert.equal(parseAmount("0.00000001"), 0.00000001);
  assert.equal(parseAmount("-0.00000001"), null);
  assert.equal(parseAmount("-1"), null);
});

test("parseAmount refuses what is not a plain number", () => {
  for (const bad of ["", "  ", "abc", "1e3", "1.2.3", "$5", "Infinity", "NaN", "1 2", "."]) {
    assert.equal(parseAmount(bad), null, bad);
  }
  assert.equal(parseAmount("9".repeat(400)), null);
});

test("snapSeconds boundary: 59 raised and flagged, 60 and 61 kept", () => {
  assert.deepEqual(snapSeconds("59", 60, 86400), { seconds: 60, snapped: true });
  assert.deepEqual(snapSeconds("60", 60, 86400), { seconds: 60, snapped: false });
  assert.deepEqual(snapSeconds("61", 60, 86400), { seconds: 61, snapped: false });
  assert.deepEqual(snapSeconds("30", 60, 86400), { seconds: 60, snapped: true });
  assert.deepEqual(snapSeconds("1", 2, 86400), { seconds: 2, snapped: true });
  assert.deepEqual(snapSeconds("2", 2, 86400), { seconds: 2, snapped: false });
});

test("snapSeconds accepts space and separators, refuses fractions and junk", () => {
  assert.deepEqual(snapSeconds(" 1,200 ", 60, 86400), { seconds: 1200, snapped: false });
  for (const bad of ["", "abc", "60.5", "-5", "1e2", "9".repeat(20)]) assert.equal(snapSeconds(bad, 60, 86400), null, bad);
});

test("settingsEntry puts id first, keeps other keys and applies the patch", () => {
  const current = { id: "old", baseCurrency: "AUD", bar: ["crypto:bitcoin", "VOO"] };
  const entry = settingsEntry("bonavr.omafolio", current, { refreshSeconds: 120 });
  assert.deepEqual(entry, { id: "bonavr.omafolio", baseCurrency: "AUD", bar: ["crypto:bitcoin", "VOO"], refreshSeconds: 120 });
  assert.deepEqual(Object.keys(entry), ["id", "baseCurrency", "bar", "refreshSeconds"]);
  assert.equal(current.id, "old");
});

test("settingsEntry writes lists as real arrays and replaces patched keys", () => {
  const entry = settingsEntry("x", { bar: ["A"] }, { bar: ["B", "A"], watch: [] });
  assert.ok(Array.isArray(entry.bar));
  assert.ok(Array.isArray(entry.watch));
  assert.deepEqual(entry.bar, ["B", "A"]);
});

test("settingsEntry treats a missing or odd entry as empty and ignores a patched id", () => {
  assert.deepEqual(settingsEntry("x", null, { range: "1Y" }), { id: "x", range: "1Y" });
  assert.deepEqual(settingsEntry("x", ["junk"], { range: "1Y" }), { id: "x", range: "1Y" });
  assert.deepEqual(settingsEntry("x", {}, { id: "y" }), { id: "x" });
});

test("kindLabel names every kind and nothing else", () => {
  assert.deepEqual(["stock", "etf", "fund", "crypto", "fx"].map(kindLabel), ["stock", "ETF", "fund", "crypto", "FX"]);
  assert.equal(kindLabel(undefined), "");
  assert.equal(kindLabel(null), "");
  assert.equal(kindLabel("future"), "");
});

test("itemLabel names the portfolio total and assets as the panel does", () => {
  assert.equal(itemLabel(PORTFOLIO_ITEM, undefined), "󰄨 Portfolio total");
  assert.equal(itemLabel("crypto:bitcoin", undefined), "₿ BTC");
  assert.equal(itemLabel("crypto:solana", undefined), "solana");
  assert.equal(itemLabel("VOO", /** @type {any} */ ({ symbol: "VOO" })), "VOO");
});

test("displayPath abbreviates home only at a path boundary", () => {
  assert.equal(displayPath("/home/u/.local/share/omafolio/portfolio.json", "/home/u"), "~/.local/share/omafolio/portfolio.json");
  assert.equal(displayPath("/home/user2/x", "/home/u"), "/home/user2/x");
  assert.equal(displayPath("/home/u/x", ""), "/home/u/x");
});

test("parentDir drops the last component", () => {
  assert.equal(parentDir("/home/u/.local/share/omafolio/portfolio.json"), "/home/u/.local/share/omafolio");
  assert.equal(parentDir("/portfolio.json"), "/");
  assert.equal(parentDir("portfolio.json"), "/");
});

test("parseAmount refuses a decimal comma or misplaced separators instead of dropping them", () => {
  for (const bad of ["1,5", "0,05", "12,50", "1,2,3", "1234,567", ",5", "1,", "1,,000", "1,0000"]) {
    assert.equal(parseAmount(bad), null, bad);
  }
});

test("parseAmount accepts thousands groups of exactly three, as formatQuantity writes them", () => {
  assert.equal(parseAmount("61,000"), 61000);
  assert.equal(parseAmount("1,250.5"), 1250.5);
  assert.equal(parseAmount("1,000,000.25"), 1000000.25);
  assert.equal(parseAmount("999"), 999);
  assert.equal(parseAmount("1,000"), 1000);
});

test("snapSeconds lowers a value above max to max without flagging it", () => {
  assert.deepEqual(snapSeconds("3599", 2, 3600), { seconds: 3599, snapped: false });
  assert.deepEqual(snapSeconds("3600", 2, 3600), { seconds: 3600, snapped: false });
  assert.deepEqual(snapSeconds("3601", 2, 3600), { seconds: 3600, snapped: false });
  assert.deepEqual(snapSeconds("99999999999", 60, 86400), { seconds: 86400, snapped: false });
  assert.deepEqual(snapSeconds("100000", 2), { seconds: 100000, snapped: false });
});

test("snapSeconds refuses misplaced separators", () => {
  assert.equal(snapSeconds("1,20", 60, 86400), null);
  assert.equal(snapSeconds("1,2,0", 60, 86400), null);
  assert.deepEqual(snapSeconds("1,200", 60, 86400), { seconds: 1200, snapped: false });
});

test("cash search results are labelled cash", () => {
  assert.equal(kindLabel("cash"), "cash");
});
