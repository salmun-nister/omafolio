import QtQuick
import Quickshell
import Quickshell.Io
import "lib/settings.mjs" as Settings
import "lib/market.mjs" as Market
import "lib/portfolio.mjs" as Portfolio
import "lib/holdings.mjs" as Holdings
import "lib/quotecache.mjs" as QuoteCache
import "lib/providers/index.mjs" as Providers
import "lib/cash.mjs" as Cash

// Prices, history, search and holdings for the widget and panel. This is the
// plugin's only I/O: curl (through Fetcher), timers and two files (written
// through AtomicFile). Every decision (what to fetch, when, how fresh a price
// is, what the portfolio is worth) is made by lib/; this object holds the
// state and runs the processes.
//
// - Quotes: each provider polls on its own timer, re-armed after every round
//   with market.nextDelayMs, so providers back off and recover independently.
//   Assets come from holdings and settings, plus the FX pairs the portfolio
//   needs; a round starts straight away whenever new assets appear (including
//   FX pairs learnt from a response) and never when there is nothing to fetch.
//   Cash is never fetched: its quotes, states and history are derived from the
//   exchange rates it is priced with (lib/cash.mjs) and merged into what this
//   object publishes.
// - Holdings: ~/.local/share/omafolio/portfolio.json, watched for edits. A file
//   that does not parse sets holdingsError and is never written over.
// - Quote cache: ~/.cache/omafolio/quotes.json, loaded at startup (those quotes
//   are marked fromCache, so they show as stale until refreshed) and rewritten
//   after successful fetches.
// Both files are written atomically with mode 600.
//
// This is the plugin's `service` entry point: the shell mounts one instance and
// every bar widget (one per monitor) shares it, so each request and each file
// write happens once. Widgets find it with bar.shell.serviceFor(<plugin id>)
// and push their settings into `settings`.
QtObject {
  id: root

  default property list<QtObject> resources

  // ---- Inputs

  // The widget's settings entry, raw or already normalised (normalising is
  // idempotent); bad values are replaced and explained in `settingsNotes`. Null
  // until a widget supplies it, and nothing is fetched before then, so the
  // defaults are never fetched by mistake. Every widget pushes the same entry.
  property var settings: null
  // Whether any panel is showing. Each monitor's widget has its own panel, and
  // they overlap: moving the popout to another monitor opens the new panel
  // before the bar closes the old one. history() fetches only while one is
  // showing. Panels report themselves with panelOpened/panelClosed.
  readonly property bool panelOpen: openPanels.length > 0

  // ---- Outputs

  // The settings in effect (lib/settings.mjs Settings).
  readonly property var config: normalized.settings
  // Latest quote per asset, FX pairs and cash included: Record<AssetRef, Quote>.
  readonly property var quotes: Object.assign({}, fetched, Cash.cashQuotes(followed, fetched, config.baseCurrency, clock))
  // Price state of every quote and every asset being fetched:
  // Record<AssetRef, PriceState>. Recomputed on every data change and every
  // 15 s, since staleness depends on the time.
  readonly property var states: priceStates()
  // Holding[] from the holdings file. While the file is unreadable this keeps
  // the last good list (empty at startup).
  property var holdings: []
  // Empty when the holdings file is fine (or absent); otherwise a sentence for
  // the user, e.g. "portfolio.json can't be read (line 4)". Saving is blocked.
  property string holdingsError: ""
  // lib/portfolio.mjs PortfolioView of `holdings` in the base currency.
  readonly property var portfolio: Portfolio.valuePortfolio(holdings, quotes, states, config.baseCurrency)
  // Health (lib/types.mjs) per provider id: {yahoo: Health, coingecko: Health}.
  property var providerHealth: ({
    yahoo: { failures: 0, failingSince: null, lastSuccess: null, lastFailure: null },
    coingecko: { failures: 0, failingSince: null, lastSuccess: null, lastFailure: null },
  })
  // User-facing explanations of settings that were substituted (string[]).
  readonly property var settingsNotes: normalized.notes
  // Sentences about the holdings file that do not block editing: the last save
  // failed (the shown holdings are then the file's), and the file had duplicate
  // entries, which are shown (and saved on the next change) combined. Empty when
  // there is nothing to say.
  readonly property string holdingsNote: [holdingsWriteError, holdingsMerged > 0
    ? "Combined " + holdingsMerged + " duplicate " + (holdingsMerged === 1 ? "entry" : "entries") + " in portfolio.json."
    : ""].filter(function(line) { return line !== "" }).join(" ")
  // Epoch ms of the last successful quote round of any provider, or null.
  property var lastUpdated: null
  // SearchResult[] for the latest search(): matching currencies as cash first
  // (lib/cash.mjs, known at once), then Yahoo, then CoinGecko, one per asset.
  property var searchResults: []
  // The cash part of searchResults for the latest query.
  property var searchCash: []
  // The (trimmed) query `searchResults` answers, and whether answers to it are
  // still coming.
  property string searchQuery: ""
  readonly property bool searching: searchFetcher.busy

  // ---- Methods

  // Manual refresh: starts a round for each provider whose last attempt is at
  // least refreshSeconds old (market.canFetchNow) and re-reads the holdings
  // file. Returns whether any request went out.
  function refresh() {
    holdingsFile.reload()
    var now = Date.now()
    var started = false
    for (const feed of [yahooFeed, coingeckoFeed]) {
      if (feed.assets.length > 0 && Market.canFetchNow(feed.lastAttemptAt, config.refreshSeconds, now)) {
        feed.start()
        started = true
      }
    }
    return started
  }

  // A panel (any object, used as its identity) is now showing. Repeats are
  // ignored, so a panel may report the same state more than once.
  function panelOpened(panel) {
    if (openPanels.indexOf(panel) < 0) openPanels = openPanels.concat([panel])
  }

  // `panel` is no longer showing, or is being destroyed. Unknown panels are
  // ignored.
  function panelClosed(panel) {
    if (openPanels.indexOf(panel) >= 0) openPanels = openPanels.filter(function(p) { return p !== panel })
  }

  // Price history of `assets` (AssetRef[]) over `range` ("1D"|"1W"|"1M"|"1Y"):
  // Record<AssetRef, Series> holding the cached series that exist. While the
  // panel is open, series that are absent or older than refreshSeconds are
  // fetched in the background, except from a provider resting after a failed
  // quote or history request (market.inBackoff); bindings that call this
  // re-evaluate when they land. An asset the provider has no history for is
  // absent from the result. Cash is drawn from its exchange rate's history,
  // which is what gets fetched for it (lib/cash.mjs).
  function history(assets, range) {
    var cache = historyCache
    var now = clock
    var maxAge = config.refreshSeconds * 1000
    var out = {}
    var due = []
    for (const asset of Cash.historySources(assets, config.baseCurrency)) {
      var key = historyKey(range, asset)
      var entry = cache[key]
      if (entry && entry.series) out[asset] = entry.series
      if (panelOpen && !historyPending[key] && (!entry || now - entry.at >= maxAge) && !historyResting(Providers.providerFor(asset).id, now)) due.push(asset)
    }
    if (due.length > 0) {
      for (const request of Providers.historyRequests(due, range, kindOf)) {
        for (const asset of request.assets) historyPending[historyKey(range, asset)] = true
        historyQueue.push(request)
      }
      historyPump.restart()
    }
    return Object.assign(out, Cash.cashSeries(assets, out, config.baseCurrency, range, now))
  }

  // Searches both providers for `query`, and the currencies cash can be held
  // in; results replace `searchResults` at once (cash) and as each provider
  // answers. A blank query clears them. Answers to an older query
  // are ignored.
  function search(query) {
    var q = String(query === undefined || query === null ? "" : query).trim()
    var requests = q === "" ? [] : Providers.searchRequests(q)
    searchQuery = q
    searchUrls = requests.map(function(r) { return r.url })
    searchByProvider = {}
    searchCash = Cash.searchCash(q)
    publishSearch()
    searchFetcher.fetch(requests)
  }

  // Writes `list` (Holding[]) to the holdings file, merged as parseHoldings
  // would read it back, and adopts it at once. Refused (returns false) while
  // holdingsError is set, before the file has first been read, or when the
  // list would not read back.
  function saveHoldings(list) {
    if (holdingsError !== "" || !ready) return false
    var text = Holdings.serializeHoldings(list)
    var check = Holdings.parseHoldings(text)
    if (!check.ok) {
      console.warn("omafolio: not saving holdings that would not read back: " + check.error)
      return false
    }
    holdingsText = text
    holdings = check.holdings
    holdingsMerged = 0
    holdingsWriter.write(text)
    return true
  }

  // ---- Implementation

  readonly property string home: Quickshell.env("HOME")
  readonly property string holdingsPath: home + "/.local/share/omafolio/portfolio.json"
  readonly property string cachePath: home + "/.cache/omafolio/quotes.json"

  // Latest quote per fetched asset (cash is derived from these, never fetched):
  // Record<AssetRef, Quote>.
  property var fetched: ({})

  // The host hands settings over as Qt types (lists are not JS arrays), so they
  // are copied into plain JSON values before validation.
  readonly property var normalized: Settings.normalizeSettings(plainJson(settings))
  // Assets the user follows (cash included), those that are fetched (cash is
  // not), and the FX pairs needed to value them.
  readonly property var followed: Market.assetsToFetch(config, holdings)
  readonly property var wanted: followed.filter(function(a) { return !Cash.isCash(a) })
  readonly property var fx: Market.fxPairs(quotesOf(wanted), holdings, config.baseCurrency, followed)
  // Assets requested whose provider answered without them (unknown symbols).
  property var notFoundAssets: ({})
  // Now, in epoch ms, advanced every 15 s so time-dependent bindings update.
  property real clock: Date.now()

  // The holdings file has been read (or found absent) at least once. Nothing
  // is fetched or saved before then.
  property bool ready: false
  // Text of the holdings file as last read or written; null forces a re-parse.
  property var holdingsText: null
  property int holdingsMerged: 0
  // Why the last holdings save failed, for holdingsNote; empty once one succeeds.
  property string holdingsWriteError: ""

  // Quote cache text as last read or written, to skip unchanged writes.
  property string cacheText: ""

  // History: "range|asset" -> {at: epoch ms, series: Series|null}; keys
  // requested and not yet answered; requests waiting their turn; and the one
  // in flight. A series is in its asset's own currency (exchange rates are
  // assets too), so the base currency is not part of the key.
  property var historyCache: ({})
  property var historyPending: ({})
  property var historyQueue: []
  property var historyCurrent: null
  // Health of history requests per provider id (lib/types.mjs Health), kept
  // apart from providerHealth, which describes quotes to the user.
  property var historyHealth: ({})

  // Panels that have reported themselves open and not yet closed.
  property var openPanels: []

  property var searchUrls: []
  property var searchByProvider: ({})

  function plainJson(value) {
    var text = value === undefined ? undefined : JSON.stringify(value)
    return text === undefined ? {} : JSON.parse(text)
  }

  function quotesOf(assets) {
    var out = {}
    for (const asset of assets) if (fetched[asset]) out[asset] = fetched[asset]
    return out
  }

  // Assets `provider` should be asked for now, in a stable order.
  function assetsFor(provider) {
    return Array.from(new Set(wanted.concat(fx))).filter(function(a) {
      return Providers.providerFor(a).id === provider
    })
  }

  function kindOf(asset) {
    var quote = fetched[asset]
    return quote ? quote.kind : undefined
  }

  function priceStates() {
    var now = clock
    var out = {}
    var assets = Object.keys(fetched).concat(wanted, fx)
    for (const asset of assets) {
      out[asset] = notFoundAssets[asset]
        ? "missing"
        : Market.priceState(fetched[asset], providerHealth[Providers.providerFor(asset).id], now)
    }
    return Object.assign(out, Cash.cashStates(followed, out, config.baseCurrency))
  }

  // Merges a provider's answer to `requested` (AssetRef[]); requested assets
  // that still have no quote at all are marked not found until one arrives.
  function acceptQuotes(requested, fresh) {
    fetched = Market.mergeQuotes(fetched, fresh, Date.now())
    var missing = Market.notFound(requested, fetched)
    var next = Object.assign({}, notFoundAssets)
    for (const asset of requested) {
      if (missing.indexOf(asset) >= 0) next[asset] = true
      else delete next[asset]
    }
    notFoundAssets = next
  }

  function setHealth(provider, health) {
    var next = Object.assign({}, providerHealth)
    next[provider] = health
    providerHealth = next
  }

  function holdingsRead(text) {
    // Our own write is the truth until the last one lands; a read in between
    // would only roll it back.
    if (holdingsWriter.busy) return
    if (ready && text === holdingsText) return
    holdingsText = text
    var result = Holdings.parseHoldings(text)
    if (result.ok) {
      holdings = result.holdings
      holdingsMerged = result.merged
      holdingsError = ""
    } else {
      holdingsError = result.line !== null
        ? "portfolio.json can't be read (line " + result.line + ")"
        : "portfolio.json can't be read: " + result.error
    }
    ready = true
  }

  function holdingsUnreadable(error) {
    if (holdingsWriter.busy) return
    // No file is an empty portfolio; it is created on the first save.
    if (error === FileViewError.FileNotFound) {
      holdingsRead("")
      return
    }
    holdingsText = null
    holdingsError = "portfolio.json can't be read (" + FileViewError.toString(error) + ")"
    ready = true
  }

  // Adopts cached quotes (lib/quotecache.mjs drops malformed entries) for
  // assets that have no fresher quote yet.
  function cacheRead(text) {
    fetched = Object.assign(QuoteCache.parseQuoteCache(text), fetched)
    cacheText = text
  }

  function writeCache() {
    var text = QuoteCache.serializeQuoteCache(fetched)
    if (text === cacheText) return
    cacheText = text
    cacheWriter.write(text)
  }

  function historyKey(range, asset) {
    return range + "|" + asset
  }

  // Whether `provider` (an id) is resting after a failed quote or history
  // request, so its history must not be requested at `now`.
  function historyResting(provider, now) {
    return Market.inBackoff(providerHealth[provider], now) || Market.inBackoff(historyHealth[provider], now)
  }

  // Records the answer to the history request in flight: `series` is the
  // parsed Series[], or null when the request failed. A series is replaced only
  // by a new one for the same asset, never by a failure or an omission. The
  // attempt time is recorded either way, and a failure also rests the
  // provider's history (historyHealth), so it is not retried at once.
  function storeHistory(series) {
    var request = historyCurrent
    var now = Date.now()
    var next = Object.assign({}, historyCache)
    for (const asset of request.assets) {
      var key = historyKey(request.range, asset)
      next[key] = { at: now, series: Market.keptSeries(next[key] ? next[key].series : null, series, asset) }
      delete historyPending[key]
    }
    historyCache = next
    var health = Object.assign({}, historyHealth)
    health[request.provider] = series
      ? Market.recordSuccess(historyHealth[request.provider], now)
      : Market.recordFailure(historyHealth[request.provider], now)
    historyHealth = health
  }

  function publishSearch() {
    var seen = {}
    var out = searchCash.slice()
    for (const provider of ["yahoo", "coingecko"]) {
      for (const result of searchByProvider[provider] || []) {
        if (seen[result.asset]) continue
        seen[result.asset] = true
        out.push(result)
      }
    }
    searchResults = out
  }

  onPanelOpenChanged: {
    if (panelOpen) return
    // Closing the panel cancels history requests still waiting their turn.
    for (const request of historyQueue) {
      for (const asset of request.assets) delete historyPending[historyKey(request.range, asset)]
    }
    historyQueue = []
  }

  // ---- Quote polling, one feed per provider.

  // Polls one provider's quotes with its own Fetcher and Timer, so providers
  // fail, back off and recover independently.
  component QuoteFeed: QtObject {
    id: feed

    required property string provider
    required property QtObject service

    // Assets this provider should be asked for now (none until the holdings
    // file has been read and a widget has supplied settings).
    readonly property var assets: service.ready && service.settings !== null ? service.assetsFor(provider) : []
    // Every quote is in its asset's own currency, so only the assets matter; a
    // new base currency shows up here as new exchange-rate pairs.
    readonly property string wantKey: assets.join(",")
    // What the latest round asked for.
    property var requested: []
    property var lastAttemptAt: null
    // Whether any request of the round in flight has failed.
    property bool roundFailed: false

    // New assets are fetched at once; the rest wait for the timer.
    onWantKeyChanged: {
      if (assets.length === 0) {
        timer.stop()
        requested = []
        return
      }
      if (assets.some(function(a) { return requested.indexOf(a) < 0 })) kick.restart()
    }

    // Starts a round now (queued behind one in flight). With nothing to fetch
    // there is no round and no timer until assets appear.
    function start() {
      timer.stop()
      if (assets.length === 0) return
      requested = assets
      lastAttemptAt = Date.now()
      fetcher.fetch(Providers.quoteRequests(assets))
    }

    function fail(reason) {
      roundFailed = true
      console.warn("omafolio: " + provider + " quotes failed: " + reason)
    }

    function finishRound() {
      var now = Date.now()
      var health = roundFailed
        ? Market.recordFailure(service.providerHealth[provider], now)
        : Market.recordSuccess(service.providerHealth[provider], now)
      service.setHealth(provider, health)
      if (!roundFailed) {
        service.lastUpdated = now
        cacheDebounce.restart()
      }
      roundFailed = false
      timer.interval = Market.nextDelayMs(provider, service.fetched, health, service.config.refreshSeconds, now)
      timer.restart()
    }

    readonly property Timer kick: Timer {
      interval: 0
      onTriggered: feed.start()
    }

    readonly property Timer timer: Timer {
      onTriggered: feed.start()
    }

    readonly property Fetcher fetcher: Fetcher {
      onFinished: function(request, status, body) {
        var fresh
        try {
          fresh = Providers.parse(request, status, body)
        } catch (e) {
          feed.fail(e.message)
          return
        }
        feed.service.acceptQuotes(request.assets, fresh)
      }
      onFailed: function(request, reason) { feed.fail(reason) }
      onDone: feed.finishRound()
    }
  }

  readonly property QuoteFeed yahooFeed: QuoteFeed { provider: "yahoo"; service: root }
  readonly property QuoteFeed coingeckoFeed: QuoteFeed { provider: "coingecko"; service: root }

  // ---- History and search fetchers.

  readonly property Fetcher historyFetcher: Fetcher {
    onFinished: function(request, status, body) {
      try {
        root.storeHistory(Providers.parse(request, status, body))
      } catch (e) {
        console.warn("omafolio: history failed: " + e.message)
        root.storeHistory(null)
      }
    }
    onFailed: function(request, reason) {
      console.warn("omafolio: history failed: " + reason)
      root.storeHistory(null)
    }
    onDone: {
      root.historyCurrent = null
      historyPump.restart()
    }
  }

  // Feeds queued history requests to the fetcher one at a time. Requests to a
  // provider that has started resting since they were queued are dropped (and
  // asked for again by history() once it has rested).
  readonly property Timer historyPump: Timer {
    interval: 0
    onTriggered: {
      if (root.historyFetcher.busy) return
      var now = Date.now()
      while (root.historyQueue.length > 0) {
        var request = root.historyQueue.shift()
        if (!root.historyResting(request.provider, now)) {
          root.historyCurrent = request
          root.historyFetcher.fetch([request])
          return
        }
        for (const asset of request.assets) delete root.historyPending[root.historyKey(request.range, asset)]
      }
    }
  }

  readonly property Fetcher searchFetcher: Fetcher {
    onFinished: function(request, status, body) {
      if (root.searchUrls.indexOf(request.url) < 0) return
      var results = []
      try {
        results = Providers.parse(request, status, body)
      } catch (e) {
        console.warn("omafolio: " + request.provider + " search failed: " + e.message)
      }
      var next = Object.assign({}, root.searchByProvider)
      next[request.provider] = results
      root.searchByProvider = next
      root.publishSearch()
    }
    onFailed: function(request, reason) {
      if (root.searchUrls.indexOf(request.url) >= 0) console.warn("omafolio: " + request.provider + " search failed: " + reason)
    }
  }

  // ---- Files

  readonly property FileView holdingsFile: FileView {
    path: root.holdingsPath
    watchChanges: true
    printErrors: false
    onLoaded: root.holdingsRead(text())
    onLoadFailed: function(error) { root.holdingsUnreadable(error) }
    onFileChanged: reload()
  }

  readonly property AtomicFile holdingsWriter: AtomicFile {
    path: root.holdingsPath
    // Re-read once the last queued write has landed, so the file stays the truth.
    onWritten: function(ok, code) {
      if (!ok) console.warn("omafolio: could not write " + root.holdingsPath + " (exit " + code + ")")
      root.holdingsWriteError = ok ? "" : "Could not save portfolio.json (exit " + code + ")."
      if (!busy) {
        root.holdingsText = null
        root.holdingsFile.reload()
      }
    }
  }

  readonly property FileView cacheFile: FileView {
    path: root.cachePath
    printErrors: false
    onLoaded: root.cacheRead(text())
  }

  readonly property AtomicFile cacheWriter: AtomicFile {
    path: root.cachePath
    onWritten: function(ok, code) {
      if (ok) return
      console.warn("omafolio: could not write " + root.cachePath + " (exit " + code + ")")
      root.cacheText = ""
    }
  }

  // Successes from both providers usually land within seconds of each other;
  // one write covers them.
  readonly property Timer cacheDebounce: Timer {
    interval: 10000
    onTriggered: root.writeCache()
  }

  // Advances `clock`, and re-reads the holdings file, which also picks up a
  // file created after startup or replaced in a way the watch misses.
  readonly property Timer ticker: Timer {
    interval: 15000
    running: true
    repeat: true
    onTriggered: {
      root.clock = Date.now()
      root.holdingsFile.reload()
    }
  }
}
