// The holdings file: parsing, validation, serialisation and edits.
//
// A holding's identity is (asset, costCurrency); costCurrency undefined means
// "the asset's listing currency". `cost` is the average cost per unit.
// Pure ES module: runs in Node and in QML's JS engine.

import { isCash } from "./cash.mjs";

/** @typedef {import("./types.mjs").Holding} Holding */

/**
 * The 1-based line of a JSON syntax error. Uses "line N" when the engine's message
 * reports it, else counts newlines before "position N", else finds the first syntax
 * error in `text` itself, since QJSEngine's message ("JSON.parse: Parse error")
 * carries no location. Null when `text` turns out to be valid JSON.
 * @param {string} message the JSON.parse error message
 * @param {string} text the text that failed to parse
 * @returns {number|null}
 */
export function jsonErrorLine(message, text) {
  const line = /line (\d+)/i.exec(message);
  if (line) return Number(line[1]);
  const pos = /position (\d+)/i.exec(message);
  const offset = pos ? Number(pos[1]) : firstSyntaxError(text);
  if (offset === null) return null;
  let count = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text[i] === "\n") count++;
  return count;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y;

/**
 * Offset of the first character at which `text` stops being valid JSON (RFC 8259),
 * `text.length` when it ends too early, or null when it is valid.
 * @param {string} text
 * @returns {number|null}
 */
function firstSyntaxError(text) {
  let i = 0;
  const skipSpace = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  /** Consumes `ch` after optional whitespace. */
  const eat = (/** @type {string} */ ch) => { skipSpace(); if (text[i] !== ch) return false; i++; return true; };
  /** Each reader consumes one construct, or returns false with `i` at the offending character. */
  const string = () => {
    if (text[i] !== '"') return false;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        ESCAPE.lastIndex = i;
        if (!ESCAPE.test(text)) return false;
        i = ESCAPE.lastIndex;
      } else if (text.charCodeAt(i) < 0x20) {
        return false;
      } else {
        i++;
      }
    }
    if (i >= text.length) return false;
    i++;
    return true;
  };
  /** @returns {boolean} */
  const value = () => {
    skipSpace();
    const c = text[i];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      if (eat(close)) return true;
      do {
        if (close === "}") {
          skipSpace();
          if (!string() || !eat(":")) return false;
        }
        if (!value()) return false;
      } while (eat(","));
      return eat(close);
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) { i += word.length; return true; }
    }
    NUMBER.lastIndex = i;
    if (!NUMBER.test(text)) return false;
    i = NUMBER.lastIndex;
    return true;
  };
  try {
    if (value()) {
      skipSpace();
      if (i === text.length) return null;
    }
  } catch (_) {
    return null; // nesting too deep for the stack: the location is unknown
  }
  return i;
}

/** @param {unknown} v @returns {v is string} */
function isNonEmptyString(v) { return typeof v === "string" && v.length > 0; }
/** @param {unknown} v @returns {v is number} */
function isNonNegativeNumber(v) { return typeof v === "number" && Number.isFinite(v) && v >= 0; }

const KNOWN_KEYS = ["asset", "quantity", "cost", "costCurrency"];

/**
 * Returns a validated Holding, or a string describing what is wrong.
 * @param {any} raw
 * @returns {Holding|string}
 */
function validateEntry(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "is not an object";
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) return `has an unknown key "${key}"`;
  }
  if (!isNonEmptyString(raw.asset)) return "needs an asset (non-empty text)";
  let asset = raw.asset;
  // Cash names its currency: "cash:EUR", whatever case it was typed in.
  if (asset.slice(0, 5).toLowerCase() === "cash:") {
    const code = asset.slice(5);
    if (!/^[A-Za-z]{3}$/.test(code)) return "needs a cash currency of three letters, like cash:EUR";
    asset = "cash:" + code.toUpperCase();
  }
  if (!isNonNegativeNumber(raw.quantity)) return "needs a quantity that is a number, 0 or more";
  if (!isNonNegativeNumber(raw.cost)) return "needs a cost that is a number, 0 or more";
  /** @type {Holding} */
  const holding = { asset, quantity: raw.quantity, cost: raw.cost };
  if (raw.costCurrency !== undefined) {
    if (!isNonEmptyString(raw.costCurrency)) return "has a costCurrency that is not non-empty text";
    holding.costCurrency = raw.costCurrency.toUpperCase();
  }
  return holding;
}

/**
 * Text naming a holding's identity, equal for two holdings exactly when they are the same
 * holding: how other modules tell apart holdings of one asset bought in different currencies.
 * @param {{asset: string, costCurrency?: string}} h
 * @returns {string}
 */
export function holdingKey(h) {
  return JSON.stringify([h.asset, h.costCurrency === undefined ? null : h.costCurrency]);
}

/** @type {(h: Holding, asset: string, costCurrency?: string) => boolean} */
const sameIdentity = (h, asset, costCurrency) => holdingKey(h) === holdingKey({ asset, costCurrency });

/**
 * Merges entries of equal identity: quantities add, cost is quantity-weighted.
 * Returns the merged list and how many entries were folded into an earlier one.
 * Fails (string) when a merged quantity or cost is no longer finite, since such
 * a value cannot be written back to the file.
 * @param {Holding[]} holdings
 * @returns {{holdings: Holding[], merged: number} | string}
 */
function mergeDuplicates(holdings) {
  /** @type {Holding[]} */
  const out = [];
  let merged = 0;
  for (const h of holdings) {
    const i = out.findIndex((o) => sameIdentity(o, h.asset, h.costCurrency));
    if (i < 0) { out.push(Object.assign({}, h)); continue; }
    merged++;
    const prev = out[i];
    const quantity = prev.quantity + h.quantity;
    let cost = prev.cost;
    // With no units in total there is no weighting; keep the first cost.
    // An empty earlier entry carries no weight, so the later cost wins exactly.
    if (prev.quantity === 0 && quantity > 0) cost = h.cost;
    else if (quantity > 0) cost = prev.cost + (h.cost - prev.cost) * (h.quantity / quantity); // no quantity*cost product, which can overflow
    if (!Number.isFinite(quantity) || !Number.isFinite(cost)) {
      return `Holdings for ${h.asset} add up to a number that is too large.`;
    }
    out[i] = Object.assign({}, prev, { quantity, cost });
  }
  return { holdings: out, merged };
}

/**
 * Parses the holdings file. Null or blank text is an empty portfolio. Any
 * invalid entry fails the whole parse (naming the entry) rather than being
 * dropped; so is an entry with an unknown key, so hand-added fields are never
 * silently lost on the next save. Entries of equal identity are merged and
 * `merged` counts those folded into an earlier one (0 when none). `line` is set
 * only for JSON syntax errors, when it can be found.
 * @param {string|null} text
 * @returns {{ok: true, holdings: Holding[], merged: number} | {ok: false, error: string, line: number|null}}
 */
export function parseHoldings(text) {
  if (text === null || text.trim() === "") return { ok: true, holdings: [], merged: 0 };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Not valid JSON: ${message}`, line: jsonErrorLine(message, text) };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.holdings)) {
    return { ok: false, error: 'Expected an object with a "holdings" list.', line: null };
  }
  /** @type {Holding[]} */
  const valid = [];
  for (let i = 0; i < data.holdings.length; i++) {
    const result = validateEntry(data.holdings[i]);
    if (typeof result === "string") return { ok: false, error: `Holding entry ${i + 1} ${result}.`, line: null };
    valid.push(result);
  }
  const result = mergeDuplicates(valid);
  if (typeof result === "string") return { ok: false, error: result, line: null };
  return { ok: true, holdings: result.holdings, merged: result.merged };
}

/**
 * Serialises to the documented layout: one holding per line, costCurrency only
 * when set, trailing newline.
 * @param {Holding[]} holdings
 * @returns {string}
 */
export function serializeHoldings(holdings) {
  const lines = holdings.map((h) => {
    let line = `  { "asset": ${JSON.stringify(h.asset)}, "quantity": ${JSON.stringify(h.quantity)}, "cost": ${JSON.stringify(h.cost)}`;
    if (h.costCurrency !== undefined) line += `, "costCurrency": ${JSON.stringify(h.costCurrency)}`;
    return line + " }";
  });
  return ['{ "holdings": [', ...lines.map((l, i) => (i < lines.length - 1 ? l + "," : l)), "]}", ""].join("\n");
}

/**
 * Returns a copy of `holdings` with the entry of the same (asset, costCurrency)
 * replaced by `holding`, or `holding` appended when there is none.
 * @param {Holding[]} holdings
 * @param {Holding} holding
 * @returns {Holding[]}
 */
export function withHolding(holdings, holding) {
  const i = holdings.findIndex((h) => sameIdentity(h, holding.asset, holding.costCurrency));
  if (i < 0) return [...holdings, holding];
  return holdings.map((h, j) => (j === i ? holding : h));
}

/**
 * Returns a copy of `holdings` without the entry of that (asset, costCurrency).
 * @param {Holding[]} holdings
 * @param {string} asset
 * @param {string} [costCurrency] undefined selects the entry with no costCurrency
 * @returns {Holding[]}
 */
export function withoutHolding(holdings, asset, costCurrency) {
  return holdings.filter((h) => !sameIdentity(h, asset, costCurrency));
}

/**
 * The cost currency to suggest for a new holding: for crypto the base currency,
 * since a coin has no listing currency and is bought with the user's own money
 * (its US dollar quotes are only how prices are fetched); for cash the base
 * currency too, its cost being the rate it was converted at; anything else
 * undefined, meaning its listing currency.
 * @param {string} asset
 * @param {string} baseCurrency
 * @returns {string|undefined}
 */
export function defaultCostCurrency(asset, baseCurrency) {
  return asset.startsWith("crypto:") || isCash(asset) ? baseCurrency : undefined;
}

/**
 * Adds a holding of `asset` (quantity 0, cost `cost`, costCurrency from
 * defaultCostCurrency) unless one of that identity is already held. `index` is
 * where the asset's holding sits in the returned list, new or existing; `added`
 * says whether the list changed.
 * @param {Holding[]} holdings
 * @param {string} asset
 * @param {string} baseCurrency
 * @param {number} [cost] Starting average cost: 0 unless the caller knows better (cash.startingCost).
 * @returns {{holdings: Holding[], index: number, added: boolean}}
 */
export function addHolding(holdings, asset, baseCurrency, cost = 0) {
  const costCurrency = defaultCostCurrency(asset, baseCurrency);
  const index = holdings.findIndex((h) => sameIdentity(h, asset, costCurrency));
  if (index >= 0) return { holdings, index, added: false };
  /** @type {Holding} */
  const holding = { asset, quantity: 0, cost };
  if (costCurrency !== undefined) holding.costCurrency = costCurrency;
  return { holdings: withHolding(holdings, holding), index: holdings.length, added: true };
}

/**
 * Returns a copy of `holdings` with the entry of that (asset, costCurrency)
 * changed in place: `quantity` and `cost` replace the old values, and a
 * `costCurrency` key (even one set to undefined, meaning the listing currency)
 * moves the entry to that currency, which changes its identity but not its
 * position.
 *
 * The file omits costCurrency when it is the asset's listing currency, so when
 * `listingCurrency` is known the edited entry's costCurrency is dropped if it
 * equals it, for a listed asset (not crypto, and not cash, whose quote is in
 * whatever the base currency is at the time). That applies to the edited entry
 * only, and not when another entry already has the asset in its listing
 * currency: the two would become one identity and be merged on save, and an
 * edit must never rewrite a row the user did not touch, so the edited entry then
 * keeps its explicit currency. Every other entry is returned as it was.
 *
 * `holdings` itself is returned when no entry has that identity, so an edit that
 * lost a race with another one does nothing rather than add a row, and the
 * caller can tell there is nothing to save.
 * @param {Holding[]} holdings
 * @param {string} asset
 * @param {string|undefined} costCurrency
 * @param {{quantity?: number, cost?: number, costCurrency?: string}} changes
 * @param {string|null} [listingCurrency] The asset's listing currency, when its quote has said it.
 * @returns {Holding[]}
 */
export function editHolding(holdings, asset, costCurrency, changes, listingCurrency) {
  if (!holdings.some((h) => sameIdentity(h, asset, costCurrency))) return holdings;
  const listed = !asset.startsWith("crypto:") && !isCash(asset);
  return holdings.map((h) => {
    if (!sameIdentity(h, asset, costCurrency)) return h;
    /** @type {Holding} */
    const next = { asset: h.asset, quantity: changes.quantity !== undefined ? changes.quantity : h.quantity,
      cost: changes.cost !== undefined ? changes.cost : h.cost };
    let currency = "costCurrency" in changes ? changes.costCurrency : h.costCurrency;
    if (listed && currency !== undefined && listingCurrency && currency === listingCurrency
      && !holdings.some((o) => o !== h && sameIdentity(o, asset, undefined))) currency = undefined;
    if (currency !== undefined) next.costCurrency = currency;
    return next;
  });
}
