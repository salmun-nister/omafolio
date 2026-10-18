import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDate,
  currencyPrefix,
  formatMoney,
  formatPrice,
  formatBarValue,
  formatBarPrice,
  formatChange,
  formatSigned,
  assetLabel,
  changeDirection,
  formatWeekday,
  formatClock,
  formatDayClock,
  formatWhen,
  formatQuantity,
  formatDayRange,
  formatWeekdayAt,
  pctDirection,
} from "../lib/format.mjs";

test("prefix is plain when currency is the base, explicit otherwise", () => {
  assert.equal(currencyPrefix("AUD", "AUD"), "$");
  assert.equal(currencyPrefix("USD", "AUD"), "US$");
  assert.equal(currencyPrefix("AUD", "USD"), "A$");
  assert.equal(currencyPrefix("EUR", "EUR"), "€");
});

test("prefix covers every dollar and symbol currency", () => {
  assert.equal(currencyPrefix("CAD", "USD"), "C$");
  assert.equal(currencyPrefix("NZD", "USD"), "NZ$");
  assert.equal(currencyPrefix("SGD", "USD"), "S$");
  assert.equal(currencyPrefix("HKD", "USD"), "HK$");
  assert.equal(currencyPrefix("NZD", "NZD"), "$");
  assert.equal(currencyPrefix("GBP", "USD"), "£");
  assert.equal(currencyPrefix("JPY", "USD"), "¥");
  assert.equal(currencyPrefix("CHF", "USD"), "CHF");
  assert.equal(currencyPrefix("SEK", "USD"), "kr");
  assert.equal(currencyPrefix("NOK", "USD"), "kr");
  assert.equal(currencyPrefix("DKK", "USD"), "kr");
  assert.equal(currencyPrefix("INR", "USD"), "₹");
  assert.equal(currencyPrefix("EUR", "USD"), "€");
});

test("prefix for an unknown currency is its code with a space", () => {
  assert.equal(currencyPrefix("XYZ", "USD"), "XYZ ");
});

test("prices: 0 decimals from 1000, 2 from 1, 4 significant below 1", () => {
  assert.equal(formatPrice(118066.4, "AUD", "AUD"), "$118,066");
  assert.equal(formatPrice(715.59, "USD", "AUD"), "US$715.59");
  assert.equal(formatPrice(0.6988, "USD", "USD"), "$0.6988");
});

test("price boundaries at 1000 and 1", () => {
  assert.equal(formatPrice(1000, "USD", "USD"), "$1,000");
  assert.equal(formatPrice(999.99, "USD", "USD"), "$999.99");
  assert.equal(formatPrice(1, "USD", "USD"), "$1.00");
  assert.equal(formatPrice(0.9999, "USD", "USD"), "$0.9999");
});

test("price below 1 keeps 4 significant digits however small", () => {
  assert.equal(formatPrice(0.001234, "USD", "USD"), "$0.001234");
  assert.equal(formatPrice(0.00000123, "USD", "USD"), "$0.000001230");
});

test("JPY prices use 0 decimals from 1", () => {
  assert.equal(formatPrice(150.4, "JPY", "JPY"), "¥150");
  assert.equal(formatPrice(0.6988, "JPY", "JPY"), "¥0.6988");
});

test("non-finite price renders as a dash", () => {
  assert.equal(formatPrice(NaN, "USD", "USD"), "—");
  assert.equal(formatPrice(Infinity, "USD", "USD"), "—");
});

test("money is whole units with separators and a leading minus", () => {
  assert.equal(formatMoney(1234567.6, "USD", "USD"), "$1,234,568");
  assert.equal(formatMoney(-1234, "AUD", "USD"), "-A$1,234");
  assert.equal(formatMoney(0, "USD", "USD"), "$0");
});

test("negative rounding to zero has no minus sign", () => {
  assert.equal(formatMoney(-0.4, "USD", "USD"), "$0");
});

test("bar value is full when it fits in 7 characters, compact beyond", () => {
  assert.equal(formatBarValue(118066), "118,066");
  assert.equal(formatBarValue(412300), "412,300");
  assert.equal(formatBarValue(1234567), "1.235M");
  assert.equal(formatBarValue(2450000), "2.45M");
});

test("bar value boundary at 7 characters", () => {
  assert.equal(formatBarValue(999999), "999,999");
  assert.equal(formatBarValue(1000000), "1M");
});

test("bar value compact form trims zeros and rolls over units", () => {
  assert.equal(formatBarValue(999999999), "1B");
  assert.equal(formatBarValue(3.2e9), "3.2B");
  assert.equal(formatBarValue(5e12), "5T");
});

test("bar value handles negatives and small values", () => {
  assert.equal(formatBarValue(-1234567), "-1.235M");
  assert.equal(formatBarValue(-1000), "-1,000");
  assert.equal(formatBarValue(0.6988), "0.6988");
  assert.equal(formatBarValue(NaN), "—");
});

test("bar value keeps sub-1 values in plain decimal form, never compacted", () => {
  assert.equal(formatBarValue(0.001234), "0.001234");
  assert.equal(formatBarValue(0.00000123), "0.000001230");
  assert.equal(formatBarValue(-0.00123), "-0.001230");
  for (const n of [0.001234, 0.0001234, 0.00000123, -0.00123, 1e-12]) {
    assert.doesNotMatch(formatBarValue(n), /e|k|M|B|T/);
  }
});

test("change has a space after the arrow", () => {
  assert.equal(formatChange(1.4), "▲ 1.4%");
  assert.equal(formatChange(-1.11), "▼ 1.1%");
  assert.equal(formatChange(0), "— 0.0%");
  assert.equal(formatChange(null), "—");
});

test("change that rounds to zero is flat", () => {
  assert.equal(formatChange(0.04), "— 0.0%");
  assert.equal(formatChange(-0.04), "— 0.0%");
  assert.equal(formatChange(0.05), "▲ 0.1%");
  assert.equal(formatChange(-0.05), "▼ 0.1%");
  assert.equal(formatChange(undefined), "—");
  assert.equal(formatChange(NaN), "—");
});

test("signed money", () => assert.equal(formatSigned(16630, "AUD", "AUD"), "+$16,630"));

test("signed money for negative, zero and rounds-to-zero", () => {
  assert.equal(formatSigned(-16630, "AUD", "AUD"), "-$16,630");
  assert.equal(formatSigned(0, "AUD", "AUD"), "$0");
  assert.equal(formatSigned(0.4, "AUD", "AUD"), "$0");
  assert.equal(formatSigned(0.5, "AUD", "AUD"), "+$1");
});

test("labels: ₿ for bitcoin, symbol otherwise", () => {
  assert.equal(assetLabel({ asset: "crypto:bitcoin", symbol: "BTC" }), "₿");
  assert.equal(assetLabel({ asset: "crypto:ethereum", symbol: "ETH" }), "ETH");
  assert.equal(assetLabel({ asset: "VOO", symbol: "VOO" }), "VOO");
});

test("change direction follows the arrow", () => {
  assert.equal(changeDirection("▲ 1.4%"), "up");
  assert.equal(changeDirection("▼ 0.1%"), "down");
  assert.equal(changeDirection("— 0.0%"), "flat");
  assert.equal(changeDirection("—"), "flat");
});

test("times are local: weekday, 24-hour clock with leading zeros, both", () => {
  const fri = new Date(2026, 9, 9, 7, 5).getTime();
  assert.equal(formatWeekday(fri), "Fri");
  assert.equal(formatClock(fri), "07:05");
  assert.equal(formatClock(new Date(2026, 9, 9, 23, 59).getTime()), "23:59");
  assert.equal(formatDayClock(fri), "Fri 07:05");
});

test("formatWhen drops the weekday only on the same local day", () => {
  const now = new Date(2026, 9, 10, 14, 0).getTime();
  assert.equal(formatWhen(new Date(2026, 9, 10, 0, 0).getTime(), now), "00:00");
  assert.equal(formatWhen(new Date(2026, 9, 9, 23, 59).getTime(), now), "Fri 23:59");
  assert.equal(formatWhen(now, now), "14:00");
});

test("quantities keep up to 8 decimals without trailing zeros", () => {
  assert.equal(formatQuantity(12), "12");
  assert.equal(formatQuantity(30.512), "30.512");
  assert.equal(formatQuantity(0.05), "0.05");
  assert.equal(formatQuantity(1250.5), "1,250.5");
  assert.equal(formatQuantity(0.1 + 0.2), "0.3");
  assert.equal(formatQuantity(0.00000001), "0.00000001");
  assert.equal(formatQuantity(0.000000004), "0");
  assert.equal(formatQuantity(-2.5), "-2.5");
  assert.equal(formatQuantity(NaN), "—");
});

test("day range: two prices without prefix, dash when either is unusable", () => {
  assert.equal(formatDayRange(712.54, 716.433, "USD"), "712.54–716.43");
  assert.equal(formatDayRange(117399, 119396, "AUD"), "117.4k–119.4k");
  // 13 characters is the longest full form; one more goes compact.
  assert.equal(formatDayRange(1000, 99999, "USD"), "1,000–99,999");
  assert.equal(formatDayRange(10000, 99999, "USD"), "10,000–99,999");
  assert.equal(formatDayRange(10000, 100000, "USD"), "10k–100k");
  assert.equal(formatDayRange(999.5, 100000, "USD"), "999.50–100k");
  assert.equal(formatDayRange(0.5, 0.52, "USD"), "0.5000–0.5200");
  assert.equal(formatDayRange(0, 1, "USD"), "0.00–1.00");
  assert.equal(formatDayRange(-1, 1, "USD"), "—");
  assert.equal(formatDayRange(1, Infinity, "USD"), "—");
});

test("exchange weekday: the UTC day of asOf shifted by the exchange's offset", () => {
  // Friday 16:00 in New York (EDT, UTC-4) is Saturday morning in Sydney.
  const fridayClose = Date.UTC(2026, 9, 9, 20, 0);
  assert.equal(formatWeekdayAt(fridayClose, -14400), "Fri");
  // 21:00 New York is already Saturday in UTC; the exchange's day is still Friday.
  assert.equal(formatWeekdayAt(Date.UTC(2026, 9, 10, 1, 0), -14400), "Fri");
  assert.equal(formatWeekdayAt(Date.UTC(2026, 9, 10, 4, 0), -14400), "Sat");
  // East of UTC: 07:00 Saturday in Sydney (UTC+11) is still Friday in UTC.
  assert.equal(formatWeekdayAt(Date.UTC(2026, 9, 9, 20, 0), 39600), "Sat");
});

test("exchange weekday falls back to local time without a usable offset", () => {
  const t = Date.UTC(2026, 9, 9, 20, 0);
  assert.equal(formatWeekdayAt(t, undefined), formatWeekday(t));
  assert.equal(formatWeekdayAt(t, NaN), formatWeekday(t));
});

test("percentage direction reads as displayed: 0.05 rounds up to 0.1, 0.04 to 0.0", () => {
  assert.equal(pctDirection(0.04), "flat");
  assert.equal(pctDirection(-0.04), "flat");
  assert.equal(pctDirection(0.05), "up");
  assert.equal(pctDirection(-0.05), "down");
  assert.equal(pctDirection(0), "flat");
  assert.equal(pctDirection(null), "flat");
});

test("bar price: plain in the base currency, prefixed otherwise", () => {
  assert.equal(formatBarPrice(82699, "USD", "USD"), "82,699");
  assert.equal(formatBarPrice(82699, "USD", "AUD"), "US$82,699");
  assert.equal(formatBarPrice(715.59, "USD", "AUD"), "US$715.59");
  assert.equal(formatBarPrice(118413, "AUD", "AUD"), "118,413");
  assert.equal(formatBarPrice(118413, "AUD", "USD"), "A$118,413");
  assert.equal(formatBarPrice(200, "EUR", "AUD"), "€200.00");
  assert.equal(formatBarPrice(5, "XYZ", "AUD"), "XYZ 5.00");
});

test("bar price: the 7-character rule applies to the number only", () => {
  // "US$999,999" is 10 characters but the number is 7: still in full.
  assert.equal(formatBarPrice(999999, "USD", "AUD"), "US$999,999");
  assert.equal(formatBarPrice(1000000, "USD", "AUD"), "US$1M");
  assert.equal(formatBarPrice(1234567, "USD", "AUD"), "US$1.235M");
});

test("bar price: no number is a bare dash, with no prefix", () => {
  assert.equal(formatBarPrice(NaN, "USD", "AUD"), "—");
  assert.equal(formatBarPrice(Infinity, "USD", "AUD"), "—");
});

test("formatDate: day and short month in local time, the year when asked", () => {
  const t = new Date(2025, 9, 12, 14, 5).getTime();
  assert.equal(formatDate(t, false), "12 Oct");
  assert.equal(formatDate(t, true), "12 Oct 2025");
  assert.equal(formatDate(new Date(2026, 0, 3).getTime(), false), "3 Jan");
});
