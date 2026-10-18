import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, CURRENCIES, DEFAULTS } from "../lib/settings.mjs";

test("defaults show bitcoin with no setup", () => {
  const { settings, notes } = normalizeSettings({});
  assert.deepEqual(settings, { baseCurrency: "USD", refreshSeconds: 60, rotateSeconds: 5, range: "1M", bar: ["crypto:bitcoin"], watch: [], nativePrices: true });
  assert.deepEqual(notes, []);
});

test("non-object input is treated as empty", () => {
  for (const raw of [null, undefined, 5, "x", []]) {
    const { settings, notes } = normalizeSettings(raw);
    assert.deepEqual(settings, DEFAULTS);
    assert.deepEqual(notes, []);
  }
});

test("currency list is the supported set", () => {
  assert.deepEqual([...CURRENCIES], ["USD", "AUD", "EUR", "GBP", "CAD", "NZD", "JPY", "CHF", "SGD", "HKD", "SEK", "NOK", "DKK", "INR"]);
});

test("refresh below 60 is used as 60 with a note", () => {
  const { settings, notes } = normalizeSettings({ refreshSeconds: 20 });
  assert.equal(settings.refreshSeconds, 60);
  assert.match(notes[0], /60s minimum/);
  assert.equal(notes[0], "60s minimum keeps you within the free price feeds' limits.");
});

test("refresh boundary: 59 raised, 60 and 61 kept", () => {
  const r59 = normalizeSettings({ refreshSeconds: 59 });
  assert.equal(r59.settings.refreshSeconds, 60);
  assert.equal(r59.notes.length, 1);
  const r60 = normalizeSettings({ refreshSeconds: 60 });
  assert.equal(r60.settings.refreshSeconds, 60);
  assert.deepEqual(r60.notes, []);
  const r61 = normalizeSettings({ refreshSeconds: 61 });
  assert.equal(r61.settings.refreshSeconds, 61);
  assert.deepEqual(r61.notes, []);
});

test("rotate boundary: 1 raised to 2, 2 and 3 kept", () => {
  const r1 = normalizeSettings({ rotateSeconds: 1 });
  assert.equal(r1.settings.rotateSeconds, 2);
  assert.equal(r1.notes.length, 1);
  const r2 = normalizeSettings({ rotateSeconds: 2 });
  assert.equal(r2.settings.rotateSeconds, 2);
  assert.deepEqual(r2.notes, []);
  assert.equal(normalizeSettings({ rotateSeconds: 3 }).settings.rotateSeconds, 3);
});

test("non-numeric intervals fall back to defaults with a note", () => {
  const r = normalizeSettings({ refreshSeconds: "fast", rotateSeconds: NaN });
  assert.equal(r.settings.refreshSeconds, 60);
  assert.equal(r.settings.rotateSeconds, 5);
  assert.equal(r.notes.length, 2);
});

test("unknown currency falls back to USD with a note", () => {
  const r = normalizeSettings({ baseCurrency: "XYZ" });
  assert.equal(r.settings.baseCurrency, "USD");
  assert.equal(r.notes.length, 1);
});

test("lowercase currency and range are accepted", () => {
  const r = normalizeSettings({ baseCurrency: "aud", range: "1y" });
  assert.equal(r.settings.baseCurrency, "AUD");
  assert.equal(r.settings.range, "1Y");
  assert.deepEqual(r.notes, []);
});

test("unknown range falls back to 1M with a note", () => {
  const r = normalizeSettings({ range: "5Y" });
  assert.equal(r.settings.range, "1M");
  assert.equal(r.notes.length, 1);
});

test("non-string bar and watch entries are dropped", () => {
  assert.deepEqual(normalizeSettings({ bar: ["VOO", 3, null] }).settings.bar, ["VOO"]);
  assert.deepEqual(normalizeSettings({ watch: ["ETH", 3, null, ""] }).settings.watch, ["ETH"]);
});

test("dropped entries are noted", () => {
  assert.equal(normalizeSettings({ bar: ["VOO", 3] }).notes.length, 1);
  assert.deepEqual(normalizeSettings({ bar: ["VOO"] }).notes, []);
});

test("empty or non-array bar falls back to bitcoin", () => {
  assert.deepEqual(normalizeSettings({ bar: [] }).settings.bar, ["crypto:bitcoin"]);
  assert.deepEqual(normalizeSettings({ bar: [7] }).settings.bar, ["crypto:bitcoin"]);
  assert.deepEqual(normalizeSettings({ bar: "VOO" }).settings.bar, ["crypto:bitcoin"]);
  assert.deepEqual(normalizeSettings({ watch: "VOO" }).settings.watch, []);
});

test("defaults are not mutated by returned settings", () => {
  const { settings } = normalizeSettings({});
  settings.bar.push("X");
  assert.deepEqual(DEFAULTS.bar, ["crypto:bitcoin"]);
});

test("constants the settings page shares", async () => {
  const s = await import("../lib/settings.mjs");
  assert.equal(s.MIN_REFRESH_SECONDS, 60);
  assert.equal(s.MIN_ROTATE_SECONDS, 2);
  assert.deepEqual([...s.RANGES], ["1D", "1W", "1M", "3M", "6M", "1Y"]);
  assert.equal(s.REFRESH_MIN_NOTE, normalizeSettings({ refreshSeconds: 1 }).notes[0]);
});

test("nativePrices: true and false are kept, absent is true without a note", () => {
  assert.equal(normalizeSettings({ nativePrices: true }).settings.nativePrices, true);
  const off = normalizeSettings({ nativePrices: false });
  assert.equal(off.settings.nativePrices, false);
  assert.deepEqual(off.notes, []);
  const absent = normalizeSettings({});
  assert.equal(absent.settings.nativePrices, true);
  assert.deepEqual(absent.notes, []);
});

test("nativePrices that is not a boolean falls back to true with a note", () => {
  for (const raw of ["false", 0, 1, null, "yes", {}]) {
    const { settings, notes } = normalizeSettings({ nativePrices: raw });
    assert.equal(settings.nativePrices, true, JSON.stringify(raw));
    assert.deepEqual(notes, ["nativePrices must be true or false; using true."], JSON.stringify(raw));
  }
});
