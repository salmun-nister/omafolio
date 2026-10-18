import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHoldings, serializeHoldings, withHolding, withoutHolding, defaultCostCurrency, jsonErrorLine,
  addHolding, editHolding, holdingKey,
} from "../lib/holdings.mjs";

const SPEC_EXAMPLE = `{ "holdings": [
  { "asset": "VOO",            "quantity": 12,     "cost": 410.25 },
  { "asset": "VTSAX",          "quantity": 30.512, "cost": 98.10 },
  { "asset": "crypto:bitcoin", "quantity": 0.05,   "cost": 61000, "costCurrency": "AUD" }
]}`;

const one = (extra = {}) => JSON.stringify({ holdings: [{ asset: "VOO", quantity: 1, cost: 1, ...extra }] });

test("null or empty text is an empty portfolio", () => {
  assert.deepEqual(parseHoldings(null), { ok: true, holdings: [], merged: 0 });
  assert.deepEqual(parseHoldings(""), { ok: true, holdings: [], merged: 0 });
  assert.deepEqual(parseHoldings("  \n"), { ok: true, holdings: [], merged: 0 });
});

test("reads the documented format", () => {
  const r = parseHoldings(SPEC_EXAMPLE);
  assert.equal(r.holdings.length, 3);
  assert.equal(r.holdings[2].costCurrency, "AUD");
  assert.equal(r.holdings[0].costCurrency, undefined);
  assert.deepEqual(r.holdings[1], { asset: "VTSAX", quantity: 30.512, cost: 98.1 });
});

test("bad JSON reports the line", () => {
  const r = parseHoldings('{\n "holdings": [\n  { "asset": "VOO", }\n]}');
  assert.equal(r.ok, false);
  assert.equal(r.line, 3);
  assert.equal(typeof r.error, "string");
});

test("jsonErrorLine prefers 'line N' in the message", () => {
  assert.equal(jsonErrorLine("Expected x in JSON at position 41 (line 3 column 20)", "a\nb\nc"), 3);
  assert.equal(jsonErrorLine("Unexpected token at line 7", ""), 7);
});

test("jsonErrorLine falls back to counting newlines before 'position N'", () => {
  const text = "ab\ncd\nef";
  assert.equal(jsonErrorLine("Unexpected token in JSON at position 0", text), 1);
  assert.equal(jsonErrorLine("Unexpected token in JSON at position 2", text), 1); // the newline itself is on line 1
  assert.equal(jsonErrorLine("Unexpected token in JSON at position 3", text), 2);
  assert.equal(jsonErrorLine("Unexpected token in JSON at position 6", text), 3);
});

// QJSEngine (Qt 6.11, omarchy-shell) reports every JSON.parse failure with exactly this
// message: no line, no position. Recorded from the running shell.
const QJS_MESSAGE = "JSON.parse: Parse error";

test("jsonErrorLine locates the error itself when the message has no location (QJSEngine)", () => {
  assert.equal(jsonErrorLine(QJS_MESSAGE, '{\n "a": 1,\n}'), 3); // trailing comma: the "}" is on line 3
  assert.equal(jsonErrorLine(QJS_MESSAGE, SPEC_EXAMPLE.replace("98.10 },", "98.10 }")), 4); // missing comma
  assert.equal(jsonErrorLine(QJS_MESSAGE, '{"a":\n"b'), 2); // unterminated string ends the text
  assert.equal(jsonErrorLine(QJS_MESSAGE, "{}\n\nx"), 3); // trailing garbage
  assert.equal(jsonErrorLine(QJS_MESSAGE, "a\nb"), 1);
});

test("jsonErrorLine agrees with V8's reported line on malformed input", () => {
  const cases = [
    '{\n "a": 1,\n}', '[1,\n2,\n]', '{"a"\n 1}', '{"a": tru\n}', '{"a": 01}', '{"a": -}', '{"a": 1.}',
    '{"a": 1e}', '{"a": "x\\q"}', '{"a": "\\u12G4"}', '{"a": "\t"}', '{"a":\n "\u001f"}', '{\n\n"a": [1 2]}', '{"a": {}}\n]', "",
    '\n\n  {"a":', SPEC_EXAMPLE.replace('"cost": 61000', '"cost": 61,000'),
  ];
  for (const text of cases) {
    let message = "";
    try { JSON.parse(text); } catch (e) { message = /** @type {Error} */ (e).message; }
    assert.notEqual(message, "", `expected ${JSON.stringify(text)} to be invalid`);
    const v8 = jsonErrorLine(message, text);
    assert.notEqual(v8, null, message);
    assert.equal(jsonErrorLine(QJS_MESSAGE, text), v8, JSON.stringify(text));
  }
});

test("jsonErrorLine is null when the message has no location and the text is valid JSON", () => {
  for (const text of ['{"a": [1, -2.5e+3, true, false, null, "\\u00e9\\n"]}', " 0 ", '"x"', '"\u0020"']) {
    assert.equal(jsonErrorLine(QJS_MESSAGE, text), null, text);
  }
});

test("top level must be an object with a holdings array", () => {
  for (const text of ["null", "[]", "5", '"x"', "{}", '{"holdings":{}}', '{"holdings":"x"}']) {
    const r = parseHoldings(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.line, null);
  }
  assert.deepEqual(parseHoldings('{"holdings":[]}'), { ok: true, holdings: [], merged: 0 });
});

test("entries with a missing asset or non-numeric quantity are an error, not dropped", () => {
  const r = parseHoldings('{"holdings":[{"asset":"VOO","quantity":"x","cost":1}]}');
  assert.equal(r.ok, false);
  assert.equal(r.line, null);
  const bad = parseHoldings('{"holdings":[{"asset":"VOO","quantity":1,"cost":1},{"quantity":1,"cost":1}]}');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /entry 2/);
});

test("asset must be a non-empty string", () => {
  assert.equal(parseHoldings(one({ asset: "" })).ok, false);
  assert.equal(parseHoldings(one({ asset: 5 })).ok, false);
  assert.equal(parseHoldings(one({ asset: "V" })).ok, true);
});

test("quantity boundary: 0 accepted, -0.0001 rejected", () => {
  assert.equal(parseHoldings(one({ quantity: 0 })).ok, true);
  assert.equal(parseHoldings(one({ quantity: 0.0001 })).ok, true);
  assert.equal(parseHoldings(one({ quantity: -0.0001 })).ok, false);
});

test("cost boundary: 0 accepted, -0.0001 rejected", () => {
  assert.equal(parseHoldings(one({ cost: 0 })).ok, true);
  assert.equal(parseHoldings(one({ cost: -0.0001 })).ok, false);
});

test("non-finite and non-number quantity or cost are rejected", () => {
  assert.equal(parseHoldings('{"holdings":[{"asset":"VOO","quantity":1e999,"cost":1}]}').ok, false);
  assert.equal(parseHoldings('{"holdings":[{"asset":"VOO","quantity":1,"cost":1e999}]}').ok, false);
  assert.equal(parseHoldings(one({ cost: null })).ok, false);
  assert.equal(parseHoldings(one({ quantity: true })).ok, false);
  assert.equal(parseHoldings('{"holdings":[{"asset":"VOO","quantity":1}]}').ok, false);
});

test("costCurrency, when present, is a non-empty string stored upper-case", () => {
  assert.equal(parseHoldings(one({ costCurrency: "" })).ok, false);
  assert.equal(parseHoldings(one({ costCurrency: 5 })).ok, false);
  assert.equal(parseHoldings(one({ costCurrency: null })).ok, false);
  assert.equal(parseHoldings(one({ costCurrency: "a" })).holdings[0].costCurrency, "A");
  assert.equal(parseHoldings(one({ costCurrency: "aud" })).holdings[0].costCurrency, "AUD");
});

test("duplicates with the same cost currency merge with weighted cost", () => {
  const r = parseHoldings('{"holdings":[{"asset":"VOO","quantity":10,"cost":400},{"asset":"VOO","quantity":10,"cost":420}]}');
  assert.deepEqual(r.holdings, [{ asset: "VOO", quantity: 20, cost: 410 }]);
  assert.equal(r.merged, 1);
});

test("merge weights by quantity and keeps first-seen position", () => {
  const r = parseHoldings(JSON.stringify({ holdings: [
    { asset: "A", quantity: 1, cost: 1 },
    { asset: "B", quantity: 1, cost: 1 },
    { asset: "A", quantity: 3, cost: 5 },
  ] }));
  assert.deepEqual(r.holdings, [{ asset: "A", quantity: 4, cost: 4 }, { asset: "B", quantity: 1, cost: 1 }]);
});

test("merging zero-quantity duplicates keeps the first cost and quantity 0", () => {
  const r = parseHoldings(JSON.stringify({ holdings: [
    { asset: "A", quantity: 0, cost: 7 },
    { asset: "A", quantity: 0, cost: 9 },
  ] }));
  assert.deepEqual(r.holdings, [{ asset: "A", quantity: 0, cost: 7 }]);
});

test("duplicates differing only in costCurrency case merge", () => {
  const r = parseHoldings(JSON.stringify({ holdings: [
    { asset: "X", quantity: 1, cost: 1, costCurrency: "aud" },
    { asset: "X", quantity: 1, cost: 3, costCurrency: "AUD" },
  ] }));
  assert.deepEqual(r.holdings, [{ asset: "X", quantity: 2, cost: 2, costCurrency: "AUD" }]);
});

test("duplicates with different cost currencies stay separate", () => {
  const r = parseHoldings('{"holdings":[{"asset":"crypto:bitcoin","quantity":1,"cost":1,"costCurrency":"AUD"},{"asset":"crypto:bitcoin","quantity":1,"cost":1,"costCurrency":"USD"}]}');
  assert.equal(r.holdings.length, 2);
});

test("a set cost currency and an unset one stay separate", () => {
  const r = parseHoldings(JSON.stringify({ holdings: [
    { asset: "X", quantity: 1, cost: 1 },
    { asset: "X", quantity: 1, cost: 1, costCurrency: "USD" },
  ] }));
  assert.equal(r.holdings.length, 2);
});

const holdings = [
  { asset: "VOO", quantity: 12, cost: 410.25 },
  { asset: "crypto:bitcoin", quantity: 0.05, cost: 61000, costCurrency: "AUD" },
];

test("round trip, one holding per line, costCurrency only when set", () => {
  const text = serializeHoldings(holdings);
  assert.deepEqual(parseHoldings(text).holdings, holdings);
  assert.equal(text.split("\n").filter(l => l.includes('"asset"')).length, holdings.length);
  assert.ok(!text.includes('"costCurrency": undefined'));
  assert.equal(text.split("\n").filter(l => l.includes("costCurrency")).length, 1);
});

test("serialised layout matches the documented shape exactly", () => {
  assert.equal(serializeHoldings(holdings), [
    '{ "holdings": [',
    '  { "asset": "VOO", "quantity": 12, "cost": 410.25 },',
    '  { "asset": "crypto:bitcoin", "quantity": 0.05, "cost": 61000, "costCurrency": "AUD" }',
    ']}',
    '',
  ].join("\n"));
});

test("an empty list serialises to a two-line object that parses back empty", () => {
  const text = serializeHoldings([]);
  assert.equal(text, '{ "holdings": [\n]}\n');
  assert.deepEqual(parseHoldings(text), { ok: true, holdings: [], merged: 0 });
});

test("the spec example round-trips", () => {
  const first = parseHoldings(SPEC_EXAMPLE).holdings;
  assert.deepEqual(parseHoldings(serializeHoldings(first)).holdings, first);
});

test("asset strings with quotes survive serialisation", () => {
  const h = [{ asset: 'A"B', quantity: 1, cost: 1 }];
  assert.deepEqual(parseHoldings(serializeHoldings(h)).holdings, h);
});

test("withHolding appends a new asset and replaces the same (asset, costCurrency)", () => {
  const base = [{ asset: "A", quantity: 1, cost: 1 }, { asset: "B", quantity: 2, cost: 2 }];
  const added = withHolding(base, { asset: "C", quantity: 3, cost: 3 });
  assert.deepEqual(added.map(h => h.asset), ["A", "B", "C"]);
  const replaced = withHolding(base, { asset: "A", quantity: 9, cost: 9 });
  assert.deepEqual(replaced, [{ asset: "A", quantity: 9, cost: 9 }, base[1]]);
});

test("withHolding treats a different costCurrency as a different entry", () => {
  const base = [{ asset: "A", quantity: 1, cost: 1, costCurrency: "AUD" }];
  assert.equal(withHolding(base, { asset: "A", quantity: 1, cost: 1, costCurrency: "USD" }).length, 2);
  assert.equal(withHolding(base, { asset: "A", quantity: 1, cost: 1 }).length, 2);
  assert.equal(withHolding(base, { asset: "A", quantity: 5, cost: 1, costCurrency: "AUD" }).length, 1);
  const unset = [{ asset: "A", quantity: 1, cost: 1 }];
  assert.equal(withHolding(unset, { asset: "A", quantity: 5, cost: 1 }).length, 1);
});

test("withoutHolding removes only the matching (asset, costCurrency)", () => {
  const base = [
    { asset: "A", quantity: 1, cost: 1 },
    { asset: "A", quantity: 1, cost: 1, costCurrency: "AUD" },
    { asset: "B", quantity: 1, cost: 1 },
  ];
  assert.deepEqual(withoutHolding(base, "A", undefined).map(h => h.costCurrency), ["AUD", undefined]);
  assert.deepEqual(withoutHolding(base, "A", "AUD").map(h => h.asset), ["A", "B"]);
  assert.equal(withoutHolding(base, "A", "USD").length, 3);
  assert.equal(withoutHolding(base, "Z").length, 3);
});

test("withHolding and withoutHolding do not mutate their input", () => {
  const base = [{ asset: "A", quantity: 1, cost: 1 }];
  const snapshot = JSON.stringify(base);
  withHolding(base, { asset: "A", quantity: 2, cost: 2 });
  withHolding(base, { asset: "B", quantity: 2, cost: 2 });
  withoutHolding(base, "A");
  assert.equal(JSON.stringify(base), snapshot);
});

test("crypto cost defaults to base; stocks to listing currency", () => {
  assert.equal(defaultCostCurrency("crypto:bitcoin", "AUD"), "AUD");
  assert.equal(defaultCostCurrency("VOO", "AUD"), undefined);
  assert.equal(defaultCostCurrency("crypto", "AUD"), undefined);
});

test("unknown keys on an entry are an error naming the entry and key", () => {
  const r = parseHoldings('{"holdings":[{"asset":"A","quantity":1,"cost":1},{"asset":"B","quantity":1,"cost":1,"note":"x"}]}');
  assert.equal(r.ok, false);
  assert.match(r.error, /entry 2/);
  assert.match(r.error, /"note"/);
  assert.equal(r.line, null);
  assert.equal(parseHoldings(one({ costCurrency: "AUD" })).ok, true);
});

test("merging that overflows to Infinity is an error naming the asset", () => {
  const big = JSON.stringify({ holdings: [
    { asset: "BIG", quantity: 1e308, cost: 1 },
    { asset: "BIG", quantity: 1e308, cost: 1 },
  ] });
  const r = parseHoldings(big);
  assert.equal(r.ok, false);
  assert.match(r.error, /BIG/);
  assert.equal(r.line, null);
});

test("weighted cost does not overflow on large costs", () => {
  const r = parseHoldings(JSON.stringify({ holdings: [
    { asset: "A", quantity: 1e200, cost: 1e200 },
    { asset: "A", quantity: 1e200, cost: 1e200 },
  ] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.holdings, [{ asset: "A", quantity: 2e200, cost: 1e200 }]);
});

test("merged counts entries folded into earlier ones", () => {
  const mk = (n) => parseHoldings(JSON.stringify({ holdings: Array.from({ length: n }, () => ({ asset: "A", quantity: 1, cost: 1 })).concat([{ asset: "B", quantity: 1, cost: 1 }]) }));
  assert.equal(mk(1).merged, 0);
  assert.equal(mk(2).merged, 1);
  assert.equal(mk(3).merged, 2);
  assert.equal(parseHoldings(SPEC_EXAMPLE).merged, 0);
});

test("a quantity-0 entry merged with a positive one yields the positive entry's cost", () => {
  for (const order of [[0, 1], [1, 0]]) {
    const entries = order.map((q) => ({ asset: "A", quantity: q, cost: q === 0 ? 7 : 9 }));
    const r = parseHoldings(JSON.stringify({ holdings: entries }));
    assert.deepEqual(r.holdings, [{ asset: "A", quantity: 1, cost: 9 }]);
    assert.equal(r.merged, 1);
  }
});

test("addHolding appends a listing-currency stock with zero quantity and cost", () => {
  const start = parseHoldings(SPEC_EXAMPLE).holdings;
  const r = addHolding(start, "VTI", "AUD");
  assert.equal(r.added, true);
  assert.equal(r.index, 3);
  assert.deepEqual(r.holdings[3], { asset: "VTI", quantity: 0, cost: 0 });
  assert.ok(!("costCurrency" in r.holdings[3]));
  assert.equal(start.length, 3);
  assert.match(serializeHoldings(r.holdings), /\{ "asset": "VTI", "quantity": 0, "cost": 0 \}/);
});

test("addHolding prices new crypto in the base currency", () => {
  const r = addHolding([], "crypto:solana", "AUD");
  assert.deepEqual(r, { holdings: [{ asset: "crypto:solana", quantity: 0, cost: 0, costCurrency: "AUD" }], index: 0, added: true });
});

test("addHolding finds an existing holding of the same identity instead of duplicating", () => {
  const start = parseHoldings(SPEC_EXAMPLE).holdings;
  const voo = addHolding(start, "VOO", "AUD");
  assert.deepEqual(voo, { holdings: start, index: 0, added: false });
  const btc = addHolding(start, "crypto:bitcoin", "AUD");
  assert.equal(btc.added, false);
  assert.equal(btc.index, 2);
});

test("addHolding adds crypto again under a different base currency (a different identity)", () => {
  const start = parseHoldings(SPEC_EXAMPLE).holdings;
  const r = addHolding(start, "crypto:bitcoin", "USD");
  assert.equal(r.added, true);
  assert.deepEqual(r.holdings[3], { asset: "crypto:bitcoin", quantity: 0, cost: 0, costCurrency: "USD" });
});

test("editHolding changes quantity or cost of that identity only", () => {
  const start = parseHoldings(SPEC_EXAMPLE).holdings;
  const q = editHolding(start, "VOO", undefined, { quantity: 15 });
  assert.deepEqual(q[0], { asset: "VOO", quantity: 15, cost: 410.25 });
  assert.deepEqual(q.slice(1), start.slice(1));
  const c = editHolding(start, "crypto:bitcoin", "AUD", { cost: 70000 });
  assert.deepEqual(c[2], { asset: "crypto:bitcoin", quantity: 0.05, cost: 70000, costCurrency: "AUD" });
  assert.equal(start[0].quantity, 12);
});

test("editHolding moves a holding to another currency in place, or back to listing", () => {
  const start = parseHoldings(SPEC_EXAMPLE).holdings;
  const usd = editHolding(start, "VOO", undefined, { costCurrency: "AUD" });
  assert.deepEqual(usd[0], { asset: "VOO", quantity: 12, cost: 410.25, costCurrency: "AUD" });
  const back = editHolding(usd, "VOO", "AUD", { costCurrency: undefined });
  assert.deepEqual(back[0], { asset: "VOO", quantity: 12, cost: 410.25 });
  assert.ok(!("costCurrency" in back[0]));
});

test("editHolding of an identity no longer held changes nothing", () => {
  const start = parseHoldings(SPEC_EXAMPLE).holdings;
  assert.equal(editHolding(start, "VOO", "USD", { quantity: 1 }), start);
  assert.equal(editHolding(start, "AAPL", undefined, { quantity: 1 }), start);
});

test("editHolding with a listing currency: the ▾ choice of the listing currency is omitted", () => {
  const start = [{ asset: "VTI", quantity: 10, cost: 250.5, costCurrency: "AUD" }];
  const out = editHolding(start, "VTI", "AUD", { costCurrency: "USD" }, "USD");
  assert.deepEqual(out, [{ asset: "VTI", quantity: 10, cost: 250.5 }]);
  assert.ok(!("costCurrency" in out[0]));
});

test("editHolding keeps a chosen currency that is not the listing one, or when the listing is unknown", () => {
  const start = [{ asset: "VTI", quantity: 10, cost: 250.5 }];
  assert.deepEqual(editHolding(start, "VTI", undefined, { costCurrency: "AUD" }, "USD")[0].costCurrency, "AUD");
  assert.deepEqual(editHolding(start, "VTI", undefined, { costCurrency: "USD" }, null)[0].costCurrency, "USD");
  assert.deepEqual(editHolding(start, "VTI", undefined, { costCurrency: "USD" })[0].costCurrency, "USD");
});

test("editHolding never omits a crypto costCurrency, which has no listing currency", () => {
  const start = [{ asset: "crypto:solana", quantity: 1, cost: 1, costCurrency: "AUD" }];
  assert.deepEqual(editHolding(start, "crypto:solana", "AUD", { quantity: 2 }, "AUD"),
    [{ asset: "crypto:solana", quantity: 2, cost: 1, costCurrency: "AUD" }]);
});

test("an amount edit of a row drops that row's redundant costCurrency", () => {
  const start = [{ asset: "VTI", quantity: 10, cost: 250.5, costCurrency: "USD" }];
  assert.deepEqual(editHolding(start, "VTI", "USD", { quantity: 11 }, "USD"), [{ asset: "VTI", quantity: 11, cost: 250.5 }]);
});

test("an unrelated row's redundant costCurrency survives a save of another row", () => {
  const vti = { asset: "VTI", quantity: 10, cost: 250.5, costCurrency: "USD" };
  const start = [vti, { asset: "VOO", quantity: 12, cost: 410.25 }];
  const out = editHolding(start, "VOO", undefined, { quantity: 13 }, "USD");
  assert.equal(out[0], vti);
  assert.equal(out[0].costCurrency, "USD");
  assert.deepEqual(out[1], { asset: "VOO", quantity: 13, cost: 410.25 });
  assert.match(serializeHoldings(out), /"asset": "VTI", "quantity": 10, "cost": 250.5, "costCurrency": "USD"/);
});

test("the edited row keeps its explicit listing currency rather than merge into another row", () => {
  const plain = { asset: "VTI", quantity: 10, cost: 200 };
  const start = [plain, { asset: "VTI", quantity: 10, cost: 300, costCurrency: "AUD" }];
  // ▾ to USD (the listing currency) while a plain VTI row exists: kept explicit, no merge.
  const picked = editHolding(start, "VTI", "AUD", { costCurrency: "USD" }, "USD");
  assert.equal(picked[0], plain);
  assert.deepEqual(picked[1], { asset: "VTI", quantity: 10, cost: 300, costCurrency: "USD" });
  const parsed = parseHoldings(serializeHoldings(picked));
  assert.equal(parsed.ok && parsed.merged, 0);
  assert.equal(parsed.ok && parsed.holdings.length, 2);
  // An amount edit of that row keeps it explicit too.
  const edited = editHolding(picked, "VTI", "USD", { quantity: 11 }, "USD");
  assert.equal(edited[0], plain);
  assert.deepEqual(edited[1], { asset: "VTI", quantity: 11, cost: 300, costCurrency: "USD" });
});

test("holdingKey tells holdings apart exactly by (asset, costCurrency)", () => {
  const key = holdingKey({ asset: "AAPL" });
  assert.equal(holdingKey({ asset: "AAPL", quantity: 3, cost: 1 }), key);
  assert.notEqual(holdingKey({ asset: "AAPL", costCurrency: "EUR" }), key);
  assert.notEqual(holdingKey({ asset: "AAPL", costCurrency: "USD" }), key);
  assert.notEqual(holdingKey({ asset: "MSFT" }), key);
});

// ---- Cash

test("a cash entry parses, its code normalised to upper case", () => {
  const r = parseHoldings('{"holdings":[{"asset":"cash:eur","quantity":5000,"cost":1.62,"costCurrency":"AUD"}]}');
  assert.deepEqual(r.holdings, [{ asset: "cash:EUR", quantity: 5000, cost: 1.62, costCurrency: "AUD" }]);
  // A capitalised prefix is still cash.
  assert.equal(parseHoldings('{"holdings":[{"asset":"Cash:usd","quantity":1,"cost":1,"costCurrency":"AUD"}]}').holdings[0].asset, "cash:USD");
});

test("a cash entry with a code that is not three letters fails, naming the entry", () => {
  for (const asset of ["cash:EURO", "cash:", "cash:E1R"]) {
    const r = parseHoldings(JSON.stringify({ holdings: [{ asset, quantity: 1, cost: 1 }] }));
    assert.deepEqual([r.ok, r.error], [false, "Holding entry 1 needs a cash currency of three letters, like cash:EUR."]);
  }
});

test("new cash costs in the base currency, starting at the cost given", () => {
  assert.equal(defaultCostCurrency("cash:EUR", "AUD"), "AUD");
  assert.deepEqual(addHolding([], "cash:EUR", "AUD", 1.65).holdings, [{ asset: "cash:EUR", quantity: 0, cost: 1.65, costCurrency: "AUD" }]);
  assert.deepEqual(addHolding([], "VOO", "AUD").holdings, [{ asset: "VOO", quantity: 0, cost: 0 }]);
});

test("editing cash keeps its cost currency even when it equals the quote's currency", () => {
  const held = [{ asset: "cash:EUR", quantity: 1, cost: 1.6, costCurrency: "AUD" }];
  assert.deepEqual(editHolding(held, "cash:EUR", "AUD", { quantity: 2 }, "AUD"), [{ asset: "cash:EUR", quantity: 2, cost: 1.6, costCurrency: "AUD" }]);
});

test("a cash entry without a costCurrency fails, since its rate would change meaning with the base", () => {
  const r = parseHoldings('{"holdings":[{"asset":"cash:EUR","quantity":5000,"cost":1.62}]}');
  assert.deepEqual([r.ok, r.error], [false, "Holding entry 1 needs a costCurrency for cash: the currency its rate is in, like AUD."]);
});
