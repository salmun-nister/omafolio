# Omafolio

An [Omarchy](https://omarchy.org) bar widget that shows live prices for stocks,
ETFs, mutual funds and crypto, and a portfolio panel with your holdings' value,
day move and unrealised gain. No account and no API key.

![Omafolio in the bar with the panel open](preview.png)

The bar rotates through the items you pick (Bitcoin by default), one at a time.
Left click opens the panel, middle click refreshes, the scroll wheel steps
through items. A shut market shows its last close dimmed, and a price that
should be updating but is not is marked with a warning.

![The bar rotating through Bitcoin, the portfolio total, VOO and VTSAX](docs/media/ticker.gif)

*Sped up: each item shows for 5 seconds by default.*

The panel has Portfolio and Watchlist tabs, a chart for 1D, 1W, 1M or 1Y, and a
row with a sparkline for every asset. Each row's percentage is its move over the
range you pick: the day move on 1D, otherwise the change across its sparkline.
Click a row, or step through rows with `j` and `k`, to see that position on its
own.

| Portfolio | One position | Watchlist |
| --- | --- | --- |
| ![The Portfolio tab: total value, day move, unrealised gain, a 1M chart and three holdings](screenshots/1-portfolio.png) | ![VOO on its own: value, gain, chart, average cost, weight and day range](screenshots/2-position.png) | ![The Watchlist tab with AAPL selected above five watched assets](screenshots/3-watchlist.png) |

The screenshots use made-up holdings.

## Install

```
omarchy plugin add https://github.com/bonavr/omafolio --enable
```

Plugins run unsandboxed inside the shell, with your user's permissions. Read
the code before you enable one, this one included. Everything that runs is
plain source in this repository: there is no build step and nothing is
downloaded at install time. Leave out `--enable` to add it without turning it
on, read it, then run `omarchy plugin enable bonavr.omafolio`.

## Settings

Settings live in the widget's entry in `~/.config/omarchy/shell.json`. The
settings page (the gear in the panel) edits them, and every change saves at
once. You can also edit the file by hand.

<img src="screenshots/4-settings.png" width="350" alt="The settings page: base currency, native prices, refresh, chart range, the bar rotation list, holdings with quantity and average cost, and the watchlist">

| Key | Default | Meaning |
|---|---|---|
| `baseCurrency` | `USD` | Currency your totals, values and gains are shown in. One of USD, AUD, EUR, GBP, CAD, NZD, JPY, CHF, SGD, HKD, SEK, NOK, DKK, INR. |
| `nativePrices` | `true` | Show each asset's price (in the bar and the watchlist) in the asset's own currency. `false` converts those prices to `baseCurrency`. |
| `refreshSeconds` | `60` | Price refresh interval. The minimum is 60; a lower value is used as 60. |
| `rotateSeconds` | `5` | Seconds each item stays in the bar. The minimum is 2. |
| `range` | `1M` | Chart range the panel opens on: `1D`, `1W`, `1M` or `1Y`. |
| `bar` | `["crypto:bitcoin"]` | Items to rotate through, in order. `portfolio` is your total; anything else is an asset reference. |
| `watch` | `[]` | Assets you follow without holding them. |

Values the widget cannot use are corrected, not rejected. A `refreshSeconds`
below 60 is used as 60 and a `rotateSeconds` below 2 as 2. A non-number, an
unknown currency, an unknown range or a `nativePrices` that is not `true` or
`false` falls back to the default. Invalid `bar` and `watch` entries (anything
but a non-blank string) are dropped, a `bar` or `watch` that is not a list is
ignored, and an empty `bar` shows Bitcoin. The settings page notes each of
these corrections except the empty-bar fallback.

While every Yahoo market in play is closed, Yahoo prices are fetched every 15
minutes instead of every `refreshSeconds`. If a provider fails, requests to it
back off from 60 seconds up to 15 minutes.

An asset reference is a Yahoo Finance symbol (`VOO`, `AAPL`, `VTSAX`), or
`crypto:` followed by a CoinGecko id (`crypto:bitcoin`). The search box on the
settings page finds the right reference for you.

### Currencies

Totals, position values, day moves in money and gains are always in
`baseCurrency`. A price belongs to its asset: a stock, ETF or fund is priced
in the currency it trades in (VOO in US dollars), and crypto is priced in US
dollars. With `nativePrices` on (the default) the bar and the watchlist show
those prices as they are; turned off, they are converted to `baseCurrency` at
the current exchange rate, or left as they are while no rate is known yet. The
percentage moves are the asset's own either way. The position view always
shows quantity × price in the asset's own currency.

Every amount in a currency other than `baseCurrency` carries its currency, so
with a base of AUD the bar shows `₿ US$82,699 ▲ 0.4%` and `VOO US$715.59`,
while with a base of USD the same coin is `₿ 82,699`. A day range in another
currency names it in its label (`Day range · US$`). Amounts in the base
currency stay as they were: plain in the bar, `$` (or the currency's own
symbol) in the panel.

Crypto, like US stocks, is converted to a non-USD base with Yahoo's exchange
rate (`USDAUD=X` and so on), so with such a base your crypto holdings depend on
Yahoo for that rate as well as on CoinGecko for the price.

## Holdings

Holdings are in `~/.local/share/omafolio/portfolio.json`, created with mode 600
the first time you add one. The settings page edits it, or you can edit it by
hand; the panel picks up changes to the file.

```json
{ "holdings": [
  { "asset": "VOO", "quantity": 12, "cost": 410.25 },
  { "asset": "VTSAX", "quantity": 30.512, "cost": 98.1 },
  { "asset": "crypto:bitcoin", "quantity": 0.05, "cost": 61000, "costCurrency": "AUD" }
]}
```

- `cost` is the average cost per unit, not the total.
- `costCurrency` is the currency `cost` is in. Leave it out when it is the
  currency the asset trades in. For crypto that is US dollars, so write the
  currency you paid in; the settings page always does, starting from your
  base currency.

What `costCurrency` does to the gain:

- **Omitted:** cost is taken to be in the asset's own currency, so the gain is
  the market move only, valued at today's exchange rate. A US fund held with a
  base currency of AUD shows the fund's gain, not what the AUD/USD rate did.
- **Set:** the cost is converted at today's rate and the gain includes currency
  movement. Set it to the currency you paid in if you want your real gain.

Entries with the same asset and the same cost currency are combined: quantities
add and the cost is the quantity-weighted average. The settings page tells you
when it has done this. Unknown keys and invalid numbers are errors.

A file that cannot be read (bad JSON, a bad entry) is never written over. The
panel shows `portfolio.json can't be read` with the line when it can find it,
and the holdings editor is read-only until you fix the file. Writes go to a
temporary file in the same directory and are renamed into place, so a crash
cannot leave a half-written file. If a save fails, the settings page says so
and the holdings go back to what the file holds.

If `portfolio.json` is a symlink (say, into a synced folder), the first save
replaces the link with a regular file and leaves the link's target as it was.
This is deliberate: the plugin never writes through a symlink. Keep the real
file at that path if you want saves to land in it.

To back up your holdings, copy the file. The settings page has an "Open folder"
button.

The last known quotes are cached in `~/.cache/omafolio/quotes.json` (mode 600),
so the bar has prices to show after a restart with no network, marked stale.
It holds symbols, prices and times, never quantities. It is safe to delete.

## Privacy

- No account, sign-in, analytics or remote logging.
- Quantities, costs, values and the holdings file never leave your machine.
- Ticker symbols do, and so do your base currency and what you type into the
  settings page's search box. Prices come from Yahoo Finance and CoinGecko,
  requested from your IP address with a generic user agent and no cookies
  (`~/.curlrc` is not read). CoinGecko is always asked for US dollar prices.
  The base currency goes to Yahoo inside exchange-rate symbols such as
  `USDAUD=X`. Each search is sent to both providers. Either provider can
  learn which assets you follow from those requests, and Yahoo your base
  currency, though not how much you hold. If that is more visibility than you
  accept, run your traffic through a VPN. Hiding the symbols themselves is not
  something this plugin does.
- Nothing private goes on a command line. File contents (holdings and the
  quote cache) reach the file writer, and request URLs (symbols and search
  text) reach `curl`, on standard input, so other users on the machine cannot
  read them from the process list.
- The settings page's text fields never touch the clipboard, so they have no
  paste. Qt's own text fields read the whole clipboard every time it changes,
  which would let another program stall the shell while the page is open.
- `shell.json` holds the symbols in your bar and watchlist, never quantities.
  If you keep `~/.config` in a dotfiles repository, that file goes with it.
  The holdings file is under `~/.local/share` so it does not.

## Data sources and limits

- Stocks, ETFs, funds and exchange rates come from Yahoo Finance's unofficial
  endpoints. Crypto comes from CoinGecko's public API. Neither needs a key and
  neither is an official or supported feed for this use, so either may change,
  throttle or block requests. When that happens the affected prices go stale
  and the panel names the provider and the time it stopped. A price the
  provider stops returning for more than 3 minutes, while still answering for
  others, also goes stale and keeps its last value.
- Free equity quotes can be delayed by the exchange. The position view shows
  the time of each quote.
- US markets are the supported case. Other Yahoo symbols may work but are
  untested. There is no holiday calendar; "closed" comes from the trading
  session Yahoo reports.
- Mutual funds have one price a day, so they have no intraday chart.
- There is no transaction history, realised gain, dividend or tax tracking.
- The widget gets prices from a shell-wide data service the plugin provides. If
  you replace Omarchy's bar with a third-party bar that does not pass services
  to widgets, the widget has no data.

## Uninstall

```
omarchy plugin remove bonavr.omafolio
```

This does not touch your holdings or the cache. To delete them too:

```
rm -r ~/.local/share/omafolio ~/.cache/omafolio
```

Remove the `bonavr.omafolio` entry from `~/.config/omarchy/shell.json` if it is
still there.

## Development

```
npm install
npm run check
```

`npm run check` runs the tests (`node --test`), the type check
(`tsc --checkJs` over `lib/`), a load check that imports every `lib/` module in
Qt's real JavaScript engine (QJSEngine, which is stricter than Node), an I/O
check that runs the file writer and the curl fetcher in a headless Quickshell,
a field check that loads the settings page the same way, confirms nothing under
it is a Qt text input and drives its fields with real key presses, and
`omarchy plugin validate .`. Everything after the type check needs Omarchy
installed, and the I/O check also needs python3.

The logic is in `lib/*.mjs`: plain modules with no network, file or Qt access,
tested in Node against recorded responses in `tests/fixtures`. The QML files
are thin and do the timers, `curl` and file I/O.

To run your working copy, symlink it into the plugins directory and restart the
shell:

```
ln -s "$PWD" ~/.config/omarchy/plugins/bonavr.omafolio
omarchy restart shell
```

Run `omarchy restart shell` after every edit. Hot reload does not apply to a
symlinked plugin.

`node scripts/live-check.mjs` calls the real Yahoo and CoinGecko endpoints with
the plugin's own request builders and parsers and reports whether each still
answers in the shape the parsers expect. Run it by hand when something looks
wrong; it is not part of `npm run check`. `scripts/record-fixtures.sh`
re-records the test fixtures.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
