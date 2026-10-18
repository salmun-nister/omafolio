# Cash holdings

Date: 2026-10-18
Status: draft for review

## Purpose

Money waiting to be invested should count in the portfolio. A holder of 5,000
euros and 2,000 Australian dollars, with an AUD base, should see both in the
total, as rows, and in the chart. The euros should show how they have done
against the Australian dollar the same way a stock shows its return: a day
move, a move over the picked range, and an unrealised gain against the rate
the money was converted at.

Success looks like this:

- Cash in any currency Yahoo prices can be added from the holdings search on
  the settings page, by typing its code or name.
- Each cash holding is a row valued in the base currency, counted in the
  total, the weights and the portfolio chart.
- Foreign cash shows its day move, its move over the picked range and its
  unrealised gain against the user's conversion rate. Cash in the base
  currency is worth its amount and never moves.
- A missing or stale exchange rate is handled exactly as a missing or stale
  stock price is.

Out of scope: cash on the watchlist and in the bar rotation; interest on cash.

## Decisions taken

- The gain is measured against the rate the user converted at, entered like a
  stock's average cost (chosen over showing no gain at all).
- Cash is added through the existing "Add a holding" search, not a separate
  Cash section.
- Percentages on rows are in the asset's own terms. For foreign cash that is
  the exchange rate into the base currency, the only terms in which cash moves.

## Approach

Cash is derived from exchange rates rather than fetched. A cash holding names
its currency (`cash:EUR`). A new module, `lib/cash.mjs`, turns that reference
into an ordinary `Quote` and `Series`, built from the `<CCY><BASE>=X` rate
quote and history the plugin already fetches to convert foreign assets. The
quote is priced in the base currency: one euro is worth the current EUR→AUD
rate in Australian dollars, its previous close is the rate's previous close,
and its history is the rate's history. Cash in the base currency is a fixed 1
with a flat history.

Everything after that point (valuation, day move, gain, weight, rows,
sparklines, the range move, the combined chart, stale and missing handling)
treats cash as any other holding, with no cash-specific branches.

Two alternatives were rejected:

- Holding the rate pair itself (`EURAUD=X`) ties the holding to one base
  currency, cannot express cash in the base currency, and labels a row with a
  Yahoo ticker.
- Pricing cash at 1 in its own currency, and letting the existing conversion
  value it, gets value and gain right for free, but the day move, the row's
  range move and its sparkline would all be flat, because those are in the
  asset's own currency. Fixing that would need cash checks in several modules.

## Holdings file

A cash holding is an ordinary entry:

```json
{ "asset": "cash:EUR", "quantity": 5000, "cost": 1.62, "costCurrency": "AUD" }
```

- `quantity` is the amount of the currency held.
- `cost` is the average rate the money was converted at: units of
  `costCurrency` per one unit of the cash currency.
- The currency after `cash:` must be three letters A–Z (stored upper case).
  Anything else fails the parse like any other invalid entry, naming it.
- `costCurrency` is always written for cash, because the cash quote's currency
  is the base currency and changes when the base does. A saved rate keeps its
  own currency, so the gain stays right after a base change: it is converted
  through the existing `<costCurrency><BASE>=X` rate as any cost is.

`holdings.defaultCostCurrency` returns the base currency for cash, as it does
for crypto. `holdings.addHolding` gains an optional starting cost: for cash the
settings page passes the current rate when it is known, so a new cash holding
starts at no gain, and 1 for cash in the base currency. Without a known rate
the cost starts at 0, as for every other holding.

## lib/cash.mjs

A pure module that owns everything specific to cash:

- `isCash(asset)` and `cashCurrency(asset)`.
- `cashPairs(holdings, baseCurrency)`: the `<CCY><BASE>=X` pairs the cash
  holdings need, for `market.fxPairs` to fetch. None for cash in the base
  currency.
- `cashQuotes(holdings, quotes, baseCurrency)`: a quote per cash asset, keyed
  by its reference, built from the rate quote. Symbol "EUR cash", name from
  the currency table ("Euro"), kind `cash`, provider `cash`, currency the base,
  price and previous close the rate's, `asOf`, `session` and `dayRange` the
  rate's. Cash in the base currency gets price and previous close 1 and the
  current time as `asOf`. No quote when the rate quote is absent.
- `cashStates(holdings, states, baseCurrency)`: a cash asset has its rate's
  price state; cash in the base currency is always `live`; a currency whose
  rate Yahoo does not know is `missing`.
- `cashSeries(asset, seriesByAsset, baseCurrency, range, now)`: the rate's
  series relabelled to the cash asset; for cash in the base currency, a flat
  two-point series at 1 spanning the range up to `now`, which never moves the
  combined chart's start.
- `searchCash(query, baseCurrency)`: search results for currencies whose code
  or name matches the query (case-insensitive, "eur", "euro", "yen"), as
  `SearchResult`s of kind `cash` with exchange "Cash".
- A table of about 40 currencies Yahoo prices as `<CCY><BASE>=X`, with names.
  The table is only for search; a hand-added code outside it still works if
  Yahoo has the rate.

`Kind` gains `"cash"`, and `Quote.provider` gains `"cash"`.

## Wiring

- `providers/index.mjs`: `providerFor` routes `cash:` references to a
  provider with no requests, so nothing tries to fetch them. Its id is
  `cash` and its health is always healthy.
- `market.fxPairs` adds `cash.cashPairs`.
- `MarketService.qml` publishes `quotes` and `states` with the cash quotes and
  states merged in (derived bindings, so they follow every rate update and a
  base change), and never writes cash quotes to the quote cache. `history()`
  asks for each cash asset's rate pair and returns `cash.cashSeries` for it.
  `search()` puts `cash.searchCash` results first, ahead of the provider
  answers.
- `panel.statusLines` leaves cash out of "Markets closed", as it does rates.

## Display

- Row: label `EUR cash`, value in the base currency, the move over the picked
  range (the day move on 1D, otherwise the change across its sparkline, as
  for every row), the rate's history as the sparkline.
- Position hero: title "EUR cash · Euro", "5,000 × $1.62" (amount × current
  rate), the unrealised gain, an "Avg rate" cell in place of "Avg cost", the
  weight, and the rate's day range when Yahoo gives one.
- Settings page: a cash row labels its fields "Amount" and "Rate"; the rate's
  currency is shown and can be changed with ▾ as a cost currency can.

## Errors and edge cases

- Unknown currency code: the rate pair comes back not found, so the cash
  holding shows "not found" and stays out of the total, as an unknown ticker
  does.
- Rate still loading, stale or behind an outage: the cash row shows the same
  "…", stale warning or outage line as a stock in that state.
- The same currency held twice with different `costCurrency`: two rows, as for
  any asset (identity is asset plus cost currency).
- Base currency changes: pairs, quotes and series are derived again for the
  new base; saved rates are converted through their own currency.

## Testing

- `tests/cash.test.mjs`: references, pairs, quotes and states from rate data
  (including base-currency cash, missing and stale rates), series (rate and
  flat), and search matching by code and name.
- `tests/holdings.test.mjs`: cash entries validate, bad codes fail naming the
  entry, default cost currency and starting cost.
- `tests/portfolio.test.mjs`: cash valued, day move, gain against the rate,
  combined chart with base-currency cash not shifting the start.
- `tests/panel.test.mjs`: cash rows, the cash hero with "Avg rate", status line
  ignoring cash.
- `tests/market.test.mjs` and `tests/providers.test.mjs`: pairs include cash,
  cash is never requested.
- `scripts/check-fields.sh`: a cash row shows Amount and Rate.
- README: a Cash section and the holdings file example.
