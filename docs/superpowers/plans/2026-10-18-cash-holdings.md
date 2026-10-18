# Cash Holdings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the portfolio hold cash in any currency, valued in the base currency, with day move, range move and unrealised gain against the rate it was converted at.

**Architecture:** A new pure module, `lib/cash.mjs`, turns `cash:<CCY>` references into ordinary quotes, states and series derived from the `<CCY><BASE>=X` rates the plugin already fetches. `MarketService.qml` merges those into what it publishes, so valuation, rows, charts and warnings handle cash with no cash branches. Cash routes to Yahoo for health, and is never fetched itself.

**Tech Stack:** Plain ES modules (Node test runner, JSDoc types checked by `tsc`), QML (Quickshell, Omarchy shell).

**Spec:** `docs/superpowers/specs/2026-10-18-cash-holdings-design.md`

## Global Constraints

- `lib/` modules must load in QJSEngine: no object spread/rest (`{...x}`), no `catch {` without a binding. Use `Object.assign`.
- `lib/` modules do no I/O (`scripts/check-io.sh`).
- Every exported function gets a JSDoc interface comment with types; `npm run typecheck` must pass.
- Cash reference format: `cash:` followed by three letters A–Z, upper case (`cash:EUR`).
- Cash quote: symbol `"<CCY> cash"`, kind `"cash"`, provider `"yahoo"`, currency = base currency.
- Search results for cash: symbol `"<CCY> cash"`, name from the table, kind `"cash"`, exchange `"Cash"`.
- `npm run check` passes at the end of every task.

## Review Focus

1. Base currency changed while holding foreign cash (EUR cash, cost 1.62 AUD, base switched to USD): value uses EURUSD, gain converts the AUD cost through AUDUSD; nothing is lost from the file. Test in Task 5.
2. A hand-written lower-case reference (`"cash:eur"`) in `portfolio.json`: accepted and normalised to `cash:EUR`, not rejected and not a separate asset. Test in Task 3.
3. A currency Yahoo does not price (`cash:XYZ`): the row says "not found" and the total excludes it, like an unknown ticker. Test in Task 5.
4. A portfolio holding only base-currency cash: the chart is a flat line and the range move reads 0.0%, not "No history yet". Test in Task 5.
5. A rate quote loaded from the quote cache (stale until refreshed): the cash row shows the stale warning naming the rate pair. Test in Task 5.

---

### Task 1: Cash quotes, states, pairs and search (`lib/cash.mjs`)

**Files:**
- Create: `lib/cash.mjs`
- Modify: `lib/types.mjs` (`Kind` gains `"cash"`)
- Test: `tests/cash.test.mjs`

**Interfaces:**
- Produces (all exported from `lib/cash.mjs`):
  - `isCash(asset: AssetRef): boolean` (true for `cash:` prefix)
  - `cashCurrency(asset: AssetRef): string` (`"cash:EUR"` → `"EUR"`)
  - `cashPairs(assets: AssetRef[], baseCurrency: string): AssetRef[]` (de-duplicated, alphabetical)
  - `cashQuotes(assets: AssetRef[], quotes: Record<AssetRef, Quote>, baseCurrency: string, now: number): Record<AssetRef, Quote>`
  - `cashStates(assets: AssetRef[], states: Record<AssetRef, PriceState>, baseCurrency: string): Record<AssetRef, PriceState>`
  - `startingCost(asset: AssetRef, quotes: Record<AssetRef, Quote>, baseCurrency: string): number`
  - `searchCash(query: string): SearchResult[]`

- [ ] **Step 1: Write the failing tests** in `tests/cash.test.mjs`, with a rate quote fixture `EURAUD=X` (price 1.65, previousClose 1.64, currency AUD, kind fx, provider yahoo, a session and a dayRange {low 1.63, high 1.66}):

```js
test("references: only cash: names cash, and the currency follows the prefix", () => {
  assert.equal(isCash("cash:EUR"), true);
  assert.equal(isCash("VOO"), false);
  assert.equal(cashCurrency("cash:EUR"), "EUR");
});
test("pairs: one per foreign currency, none for the base, non-cash ignored", () => {
  assert.deepEqual(cashPairs(["cash:USD", "VOO", "cash:EUR", "cash:AUD", "cash:EUR"], "AUD"), ["EURAUD=X", "USDAUD=X"]);
});
test("quote: priced in the base at the rate, with its close, time, session and day range", () => {
  const q = cashQuotes(["cash:EUR", "VOO"], { "EURAUD=X": rate }, "AUD", NOW)["cash:EUR"];
  assert.deepEqual([q.asset, q.symbol, q.name, q.kind, q.provider, q.currency, q.price, q.previousClose, q.asOf],
    ["cash:EUR", "EUR cash", "Euro", "cash", "yahoo", "AUD", 1.65, 1.64, rate.asOf]);
  assert.deepEqual([q.session, q.dayRange], [rate.session, rate.dayRange]);
});
test("quote: base-currency cash is 1 now; no rate means no quote; an unlisted code is named by its code", () => {
  const out = cashQuotes(["cash:AUD", "cash:EUR", "cash:XYZ"], { "XYZAUD=X": Object.assign({}, rate, { asset: "XYZAUD=X" }) }, "AUD", NOW);
  assert.deepEqual([out["cash:AUD"].price, out["cash:AUD"].previousClose, out["cash:AUD"].asOf, out["cash:AUD"].session], [1, 1, NOW, null]);
  assert.equal("cash:EUR" in out, false);
  assert.equal(out["cash:XYZ"].name, "XYZ");
});
test("states: a cash asset has its rate's state, base cash is live, no state is missing", () => {
  assert.deepEqual(cashStates(["cash:EUR", "cash:AUD", "cash:JPY"], { "EURAUD=X": "stale" }, "AUD"),
    { "cash:EUR": "stale", "cash:AUD": "live", "cash:JPY": "missing" });
});
test("starting cost: 1 for base cash, the current rate when known, else 0", () => {
  assert.equal(startingCost("cash:AUD", {}, "AUD"), 1);
  assert.equal(startingCost("cash:EUR", { "EURAUD=X": rate }, "AUD"), 1.65);
  assert.equal(startingCost("cash:JPY", {}, "AUD"), 0);
});
test("search: by code or name, case-insensitive, blank finds nothing", () => {
  assert.deepEqual(searchCash("eur")[0], { asset: "cash:EUR", symbol: "EUR cash", name: "Euro", kind: "cash", exchange: "Cash" });
  assert.equal(searchCash("yen")[0].asset, "cash:JPY");
  assert.deepEqual(searchCash("  "), []);
});
```

- [ ] **Step 2: Run** `node --test tests/cash.test.mjs`. Expected: FAIL, cannot find module `../lib/cash.mjs`.

- [ ] **Step 3: Implement `lib/cash.mjs`** with the interfaces above and add `"cash"` to `Kind` in `lib/types.mjs`. Header comment: what a cash reference is and that cash is derived from `<CCY><BASE>=X` rates, never fetched. The currency table, in this order, is exactly: USD US dollar, AUD Australian dollar, EUR Euro, GBP British pound, JPY Japanese yen, CAD Canadian dollar, NZD New Zealand dollar, CHF Swiss franc, SGD Singapore dollar, HKD Hong Kong dollar, CNY Chinese yuan, KRW South Korean won, TWD Taiwan dollar, INR Indian rupee, THB Thai baht, MYR Malaysian ringgit, IDR Indonesian rupiah, PHP Philippine peso, VND Vietnamese dong, PKR Pakistani rupee, SEK Swedish krona, NOK Norwegian krone, DKK Danish krone, ISK Icelandic króna, PLN Polish złoty, CZK Czech koruna, HUF Hungarian forint, RON Romanian leu, TRY Turkish lira, ILS Israeli shekel, AED UAE dirham, SAR Saudi riyal, QAR Qatari riyal, KWD Kuwaiti dinar, EGP Egyptian pound, NGN Nigerian naira, KES Kenyan shilling, ZAR South African rand, MXN Mexican peso, BRL Brazilian real, ARS Argentine peso, CLP Chilean peso, COP Colombian peso. Search matches a query contained in the code or the name, results in table order.

- [ ] **Step 4: Run** `node --test tests/cash.test.mjs` then `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `git add lib/cash.mjs lib/types.mjs tests/cash.test.mjs && git commit -m "Add cash quotes, states and search derived from exchange rates"`

### Task 2: Cash history (`lib/cash.mjs`)

**Files:**
- Modify: `lib/cash.mjs`
- Test: `tests/cash.test.mjs`

**Interfaces:**
- Consumes: Task 1's `isCash`, `cashCurrency`.
- Produces:
  - `historySources(assets: AssetRef[], baseCurrency: string): AssetRef[]` (input order, cash replaced by its pair, base cash dropped, each once)
  - `cashSeries(assets: AssetRef[], seriesByAsset: Record<AssetRef, Series>, baseCurrency: string, range: Range, now: number): Record<AssetRef, Series>`

- [ ] **Step 1: Write the failing tests:**

```js
test("history sources: cash becomes its rate pair, base cash needs nothing", () => {
  assert.deepEqual(historySources(["VOO", "cash:EUR", "cash:AUD", "EURAUD=X"], "AUD"), ["VOO", "EURAUD=X"]);
});
test("cash series: the rate's series under the cash asset; none while the rate has none", () => {
  const eur = { asset: "EURAUD=X", currency: "AUD", points: [[0, 1.6], [60000, 1.65]] };
  const out = cashSeries(["cash:EUR", "cash:JPY", "VOO"], { "EURAUD=X": eur }, "AUD", "1M", NOW);
  assert.deepEqual(out["cash:EUR"], { asset: "cash:EUR", currency: "AUD", points: eur.points });
  assert.deepEqual(Object.keys(out), ["cash:EUR"]);
});
test("cash series: base cash is flat at 1 across the range's span", () => {
  assert.deepEqual(cashSeries(["cash:AUD"], {}, "AUD", "1W", NOW)["cash:AUD"],
    { asset: "cash:AUD", currency: "AUD", points: [[NOW - 7 * DAY, 1], [NOW, 1]] });
});
```

- [ ] **Step 2: Run** `node --test tests/cash.test.mjs`. Expected: FAIL, `historySources` is not exported.

- [ ] **Step 3: Implement** both functions. Range spans: 1D = 1 day, 1W = 7 days, 1M = 30 days, 1Y = 365 days.

- [ ] **Step 4: Run** `node --test tests/cash.test.mjs` then `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `git commit -am "Derive cash history from exchange-rate history"`

### Task 3: Cash in the holdings file (`lib/holdings.mjs`)

**Files:**
- Modify: `lib/holdings.mjs` (`validateEntry`, `defaultCostCurrency`, `addHolding`, `editHolding`)
- Test: `tests/holdings.test.mjs`

**Interfaces:**
- Consumes: `isCash` from Task 1.
- Produces: `addHolding(holdings, asset, baseCurrency, cost = 0)`. The new fourth parameter is the starting cost; otherwise as before.

- [ ] **Step 1: Write the failing tests:**

```js
test("a cash entry parses, its code normalised to upper case", () => {
  const r = parseHoldings('{"holdings":[{"asset":"cash:eur","quantity":5000,"cost":1.62,"costCurrency":"AUD"}]}');
  assert.deepEqual(r.holdings, [{ asset: "cash:EUR", quantity: 5000, cost: 1.62, costCurrency: "AUD" }]);
});
test("a cash entry with a code that is not three letters fails, naming the entry", () => {
  const r = parseHoldings('{"holdings":[{"asset":"cash:EURO","quantity":1,"cost":1}]}');
  assert.deepEqual([r.ok, r.error], [false, "Holding entry 1 needs a cash currency of three letters, like cash:EUR."]);
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
```

- [ ] **Step 2: Run** `node --test tests/holdings.test.mjs`. Expected: the four new tests FAIL.

- [ ] **Step 3: Implement.** In `validateEntry`, a `cash:` asset (prefix matched case-insensitively) must be followed by `/^[A-Za-z]{3}$/`, and is stored as `"cash:" + code.toUpperCase()`. In `editHolding`, `listed` excludes cash as well as crypto. Update the doc comments of `defaultCostCurrency` and `addHolding`.

- [ ] **Step 4: Run** `node --test tests/holdings.test.mjs` then `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `git commit -am "Accept cash in the holdings file"`

### Task 4: Routing, names and exchange-rate pairs

**Files:**
- Modify: `lib/providers/index.mjs` (`providerFor`), `lib/barframe.mjs` (`shortName`), `lib/market.mjs` (`fxPairs`)
- Test: `tests/providers.test.mjs`, `tests/barframe.test.mjs`, `tests/market.test.mjs`

**Interfaces:**
- Consumes: `isCash`, `cashCurrency`, `cashPairs` from Task 1.
- Produces: `fxPairs(quotes, holdings, baseCurrency, followed = [])`, where `followed` is any asset list whose cash assets add their pairs. Result is still de-duplicated and alphabetical.

- [ ] **Step 1: Write the failing tests:**

```js
// providers.test.mjs
test("cash routes to Yahoo, whose rates price it, but is never put in a request", () => {
  assert.equal(providerFor("cash:EUR").id, "yahoo");
  assert.deepEqual(quoteRequests(["cash:EUR"]), []);
});
// barframe.test.mjs
test("a cash reference is named by its currency", () => {
  assert.equal(shortName("cash:EUR"), "EUR cash");
});
// market.test.mjs
test("fx pairs include the rates followed cash needs", () => {
  assert.deepEqual(fxPairs(quotes, [], "AUD", ["cash:EUR", "cash:AUD", "VOO"]), ["EURAUD=X", "USDAUD=X"]);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: the three new tests FAIL.

- [ ] **Step 3: Implement.** `providerFor` returns `yahoo` for cash. The Yahoo partition in `providers/index.mjs` drops cash assets, so `quoteRequests` and `historyRequests` never include them. `shortName` returns `cashCurrency(asset) + " cash"` for cash. `fxPairs` adds `cashPairs(followed, baseCurrency)`.

- [ ] **Step 4: Run** `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `git commit -am "Route cash to Yahoo and fetch the rates it needs"`

### Task 5: Cash through valuation and the panel

**Files:**
- Modify: `lib/panel.mjs` (`assetHero`'s cost cell, `statusLines`), `lib/settingspage.mjs` (`KIND_LABELS`)
- Test: `tests/portfolio.test.mjs`, `tests/panel.test.mjs`, `tests/settingspage.test.mjs`

**Interfaces:**
- Consumes: `cashQuotes`, `cashStates`, `cashSeries` from Tasks 1–2, to build fixtures the way MarketService will publish them.

- [ ] **Step 1: Write the failing tests.** Fixtures: base AUD, `EURAUD=X` at 1.65 (prev 1.64), `AUDUSD=X` at 0.66, holdings `{cash:EUR, 5000, 1.6, AUD}` and `{cash:AUD, 2000, 1, AUD}`, quotes and states merged from `cashQuotes`/`cashStates`.

```js
// portfolio.test.mjs: one helper at file level, since rates are binary fractions
const cents = (n) => Math.round(n * 100) / 100;
test("cash is valued at the rate, moves with it, and gains against the rate converted at", () => {
  const p = valuePortfolio(cashHoldings, cashQuotesAUD, cashStatesAUD, "AUD");
  const eur = p.positions.find((x) => x.asset === "cash:EUR");
  assert.deepEqual([eur.value, eur.dayChange, eur.gain].map(cents), [8250, 50, 250]);
  assert.equal(p.positions.find((x) => x.asset === "cash:AUD").gain, 0);
  assert.equal(cents(p.total), 10250);
});
test("after a base change, cash bought with AUD gains through the AUD rate", () => {   // Review Focus 1
  const p = valuePortfolio([cashHoldings[0]], usdQuotes, usdStates, "USD");   // EURUSD 1.09, AUDUSD 0.66
  assert.equal(cents(p.positions[0].value), 5450);
  assert.equal(cents(p.positions[0].gain), cents(5450 - 5000 * 1.6 * 0.66));
});
test("a portfolio of base cash alone charts flat", () => {   // Review Focus 4
  const s = combinedSeries([cashHoldings[1]], cashSeries(["cash:AUD"], {}, "AUD", "1M", NOW), {}, "1M", "AUD");
  assert.deepEqual(rangeChange(s), { change: 0, pct: 0 });
});
// panel.test.mjs
test("a cash hero shows amount × rate and its average rate", () => {
  const hero = assetHero("cash:EUR", cashData, position("cash:EUR", "AUD"));
  assert.deepEqual([hero.title, hero.subLabel, hero.details[0]], ["EUR cash · Euro", "5,000 × $1.65", { label: "Avg rate", value: "$1.60" }]);
});
test("cash rows: not found for an unknown code, stale warning from a cached rate", () => {   // Review Focus 3, 5
  // cash:XYZ with states["XYZAUD=X"] = "missing" and Yahoo healthy → value "not found", out of the total.
  // EURAUD=X state "stale" → the cash:EUR row tooltip names EURAUD=X as stale.
});
test("cash does not count towards Markets closed", () => {
  // statusLines over ["cash:EUR"] with EURAUD=X closed yields no closed line.
});
// settingspage.test.mjs
test("cash search results are labelled cash", () => { assert.equal(kindLabel("cash"), "cash"); });
```

Fill in the last three tests' assertions from their comments with the exact strings the existing tests use for "not found" and stale tooltips (`"XYZ cash not found, not included"` follows `explain`'s wording).

- [ ] **Step 2: Run** `npm test`. Expected: the hero, status-line and kind-label tests FAIL; the valuation tests may already pass, which confirms cash needs no valuation changes.

- [ ] **Step 3: Implement.** In `assetHero` the cost cell is labelled "Avg rate" for cash and "Avg cost" otherwise. `statusLines` leaves out quotes of kind `"cash"` as it does `"fx"`. `KIND_LABELS` gains `cash: "cash"`.

- [ ] **Step 4: Run** `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `git commit -am "Show cash in the panel with its average rate"`

### Task 6: Wire cash into MarketService and the settings page

**Files:**
- Modify: `MarketService.qml`, `SettingsPage.qml`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `market.quotes` and `market.states` now include cash; `market.search(query)` puts cash results first.

- [ ] **Step 1: MarketService.** Rename the writable `quotes` property to `fetched` (every internal read and write, including `acceptQuotes`, `cacheRead`, `writeCache`, `kindOf`, `quotesOf`, `priceStates` and the feeds' `nextDelayMs` call). Add:
  - `followed`, which is `Market.assetsToFetch(config, holdings)`.
  - `wanted`, which is `followed` without cash.
  - `fx`, which is `Market.fxPairs(quotesOf(wanted), holdings, config.baseCurrency, followed)`.
  - `quotes`, which is `Object.assign({}, fetched, Cash.cashQuotes(followed, fetched, base, clock))`.
  - `states`, which is `priceStates()` merged with `Cash.cashStates(followed, those states, base)`.

  Then wire history and search:
  - `history()` fetches `Cash.historySources(assets, base)` and returns its result with `Cash.cashSeries(assets, result, base, range, clock)` added.
  - `search()` sets `searchResults` to `Cash.searchCash(q)` at once, and `publishSearch` puts those first. Keep the cash results for the current query in a property.

  Update the header comment's Quotes bullet to say cash is derived, not fetched.

- [ ] **Step 2: SettingsPage.** `addHolding(result)` passes `Cash.startingCost(result.asset, market.quotes, base)` as the fourth argument. Replace the caption under the holdings with: "Avg cost is in the asset's own currency unless you change it with ▾. For cash, quantity is the amount and avg cost the rate you converted at."

- [ ] **Step 3: README.** Add a "Cash" subsection under Settings with the `cash:EUR` file example, how to add cash from the search, what the rate means, and that base-currency cash never moves. Add `cash:` to the "An asset reference is…" paragraph.

- [ ] **Step 4: Run** `npm run check`. Expected: all pass, including `check-fields.sh` (the page still loads) and `omarchy plugin validate`.

- [ ] **Step 5: Live check.** Reload the shell (`omarchy-restart-shell` or the plugin reload). In settings, search "euro", add EUR cash, set quantity 1000 and leave the starting rate. Confirm the row "EUR cash" appears in the panel with an AUD value, a sparkline on 1M, the range percentage changing across 1D/1W/1M/1Y, and the total rising by that value. Remove it afterwards if it was only a test.

- [ ] **Step 6: Commit** `git commit -am "Hold cash: derive it in MarketService and add it from the holdings search"`
