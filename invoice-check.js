// ==============================================================================
// invoice-check.js
// LCDC — Stage 2a: Commercial Invoice parser + comparison against the LC
//
// Scope, deliberately narrow:
//   - Text-based PDFs only (PDF.js text layer). No OCR. A scanned/photographed
//     invoice will not extract cleanly — this is flagged to the user, not
//     silently guessed at.
//   - Extracts: invoice amount + currency, invoice date. Goods description
//     comparison is intentionally NOT attempted here — free-text matching
//     of goods description is Tier 2 territory and needs the same
//     fuzzball.js + real-sample calibration work already parked for the
//     46A classifier. Doing it here with naive substring matching would
//     be more likely to mislead than help.
//   - Compares against fields already parsed from the LC (32B amount).
//     Does not re-parse the LC.
// ==============================================================================

// ------------------------------------------------------------------
// parseLcAmount(raw32B)
//
// LC field 32B looks like "USD125000,00" — 3-letter currency code
// immediately followed by amount, with a COMMA as decimal separator
// (SWIFT field format convention, not a thousands separator).
// Returns { currency, amount } or null if it doesn't match the
// expected shape.
// ------------------------------------------------------------------
function parseLcAmount(raw32B) {
  if (!raw32B) return null;
  const m = raw32B.trim().match(/^([A-Z]{3})([\d,.]+)$/);
  if (!m) return null;
  const currency = m[1];
  // SWIFT uses comma as decimal point: "125000,00" -> 125000.00
  const amount = parseFloat(m[2].replace(",", "."));
  if (isNaN(amount)) return null;
  return { currency, amount };
}


// ------------------------------------------------------------------
// extractInvoiceAmounts(text)
//
// Scans free-form invoice text for currency+amount patterns. Real
// invoices are not standardized, so this looks for several common
// shapes rather than one fixed format:
//   USD 125,000.00 | USD125000.00 | $125,000.00 | 125000.00 USD
//   "Total: USD 125,000.00" | "Grand Total ... 125,000.00"
//
// Returns an array of { currency, amount, context } — context is the
// short surrounding text, so the UI can show the user exactly what
// was matched rather than a bare number with no traceability.
//
// This deliberately returns ALL candidates found, not just one guess.
// Invoices often contain several numbers (subtotal, tax, total,
// unit price x quantity) and picking the "right" one from text alone
// is unreliable. The comparison step below matches against the LC
// amount specifically, rather than assuming the first or largest
// number is the total.
// ------------------------------------------------------------------
function extractInvoiceAmounts(rawText) {
  // PDF.js text extraction frequently inserts stray spaces around commas
  // and decimal points when pulling text out of table/column layouts —
  // "USD 125 , 000 . 00" instead of "USD 125,000.00" is a common real
  // artifact, not a rare edge case. Left unhandled, this breaks the
  // amount match silently (it would parse as 125 instead of 125000).
  // Normalizing " , " -> "," and " . " -> "." before matching handles
  // this whole class of spacing artifacts in one place, rather than
  // trying to special-case every spacing variant in the regex itself.
  const text = rawText.replace(/(\d)\s+([,.])\s+(\d)/g, "$1$2$3")
                       .replace(/(\d)\s+([,.])(\d)/g, "$1$2$3")
                       .replace(/(\d)([,.])\s+(\d)/g, "$1$2$3");

  const results = [];
  const currencyCodes = "USD|EUR|GBP|INR|JPY|AED|SGD|AUD|CAD|CHF|CNY|HKD";

  // Decimal part is OPTIONAL: real invoices often write whole-number
  // amounts with no ".00" at all ("USD 125000" rather than "USD 125000.00").
  // Requiring \.\d{2} would silently miss every one of those.
  const amountShape = "[\\d,]+(?:\\.\\d{2})?";

  // Pattern A: CODE then amount  ("USD 125,000.00", "USD125000.00", "USD 125000")
  const reA = new RegExp(`\\b(${currencyCodes})\\s*(${amountShape})\\b`, "gi");
  // Pattern B: amount then CODE  ("125,000.00 USD", "125000 USD")
  const reB = new RegExp(`\\b(${amountShape})\\s*(${currencyCodes})\\b`, "gi");
  // Pattern C: common currency SYMBOLS instead of ISO codes ("$125,000.00",
  // "€125.000,00", "₹1,25,000.00"). Symbols are ambiguous — "$" alone
  // doesn't tell us USD vs CAD vs AUD — so these are tagged with
  // currency: null rather than guessing. The UI is responsible for
  // telling the user "found an amount but couldn't confirm the currency,
  // check this by eye" rather than this function pretending certainty
  // it doesn't have.
  const reC = new RegExp(`([$€£₹])\\s*(${amountShape})\\b`, "g");

  let m;
  while ((m = reA.exec(text)) !== null) {
    results.push(makeAmountEntry(m[1].toUpperCase(), m[2], text, m.index));
  }
  while ((m = reB.exec(text)) !== null) {
    results.push(makeAmountEntry(m[2].toUpperCase(), m[1], text, m.index));
  }
  while ((m = reC.exec(text)) !== null) {
    // Skip if this exact position was already captured by reA/reB
    // (avoids double-counting "USD $125,000.00" style text)
    const already = results.some(r => Math.abs(r._index - m.index) < 15);
    if (!already) {
      const entry = makeAmountEntry(null, m[2], text, m.index);
      entry.symbol = m[1];
      results.push(entry);
    }
  }

  return results;
}

function makeAmountEntry(currency, rawAmount, fullText, matchIndex) {
  const amount = parseFloat(rawAmount.replace(/,/g, ""));
  const start = Math.max(0, matchIndex - 30);
  const end = Math.min(fullText.length, matchIndex + 40);
  const context = fullText.slice(start, end).replace(/\s+/g, " ").trim();
  return { currency, amount, context, _index: matchIndex };
}


// ------------------------------------------------------------------
// extractInvoiceDate(text)
//
// Looks for a labeled invoice date — deliberately requires a nearby
// label ("Invoice Date", "Date:", "Dated") rather than matching any
// date-shaped string in the document, since invoices contain many
// dates (PO date, delivery date, due date) and guessing which bare
// date is "the" invoice date would be unreliable.
//
// Supports common written formats: "14 May 2026", "14-May-2026",
// "05/14/2026", "2026-05-14". Returns the matched raw string as-is —
// deliberately NOT normalized to a single format, because normalizing
// a date without knowing whether the source used DD/MM or MM/DD would
// risk silently getting it wrong. The raw text is shown to the user
// to read for themselves.
// ------------------------------------------------------------------
function extractInvoiceDate(text) {
  // Matches one of three concrete date shapes directly after a label,
  // rather than a loose character class — a loose class like
  // [0-9A-Za-z,/\-\s]{6,20} over-matches and bleeds into whatever text
  // follows the date on the same line (e.g. capturing "14 May 2026 Seller"
  // when "Seller:" appears right after on the same line).
  const shapes = [
    /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/,           // 14/05/2026, 14-05-2026
    /\d{4}-\d{2}-\d{2}/,                            // 2026-05-14
    /\d{1,2}[\s\-][A-Za-z]{3,9}[\s\-]\d{2,4}/       // 14 May 2026, 14-May-2026
  ];
  const combined = shapes.map(s => `(?:${s.source})`).join("|");
  const labeled = new RegExp(`(?:invoice\\s*date|dated|date)\\s*[:\\-]?\\s*(${combined})`, "i");
  const m = text.match(labeled);
  if (!m) return null;
  return m[1].trim();
}


// ------------------------------------------------------------------
// compareInvoiceToLc(invoiceText, lcAmountRaw32B)
//
// Top-level entry point. Extracts what it can from the invoice text
// and compares against the LC's own amount field. Returns a result
// object the UI can render directly — never throws on messy input,
// always returns a usable (if partial) result.
// ------------------------------------------------------------------
function compareInvoiceToLc(invoiceText, lcAmountRaw32B) {
  const lc = parseLcAmount(lcAmountRaw32B);
  const foundAmounts = extractInvoiceAmounts(invoiceText || "");
  const invoiceDate = extractInvoiceDate(invoiceText || "");

  const result = {
    lcAmount: lc,
    foundAmounts,
    invoiceDate,
    amountMatch: "unknown", // "match" | "mismatch" | "not_found" | "lc_amount_missing"
    matchedEntry: null
  };

  if (!lc) {
    result.amountMatch = "lc_amount_missing";
    return result;
  }

  if (foundAmounts.length === 0) {
    result.amountMatch = "not_found";
    return result;
  }

  // Look for an amount+currency pair matching the LC value.
  //
  // IMPORTANT: comparing floating-point decimals directly is unsafe here.
  // 125000 - 124999.99 does not equal exactly 0.01 in IEEE 754 floating
  // point — it comes out as 0.00999999999476131, which is LESS than a
  // naive "< 0.01" tolerance check. That would silently treat a real
  // 1-cent discrepancy as a match, which is exactly the kind of error
  // this tool exists to catch. Converting both values to integer cents
  // before comparing avoids this entirely — integer arithmetic has no
  // representation error.
  const toCents = n => Math.round(n * 100);
  const exact = foundAmounts.find(
    f => f.currency === lc.currency && toCents(f.amount) === toCents(lc.amount)
  );

  if (exact) {
    result.amountMatch = "match";
    result.matchedEntry = exact;
    return result;
  }

  // Symbol-only entries (currency: null) can't be confirmed against the
  // LC's ISO currency code, but if the AMOUNT matches, it's worth
  // surfacing rather than reporting a flat "not found" — the user can
  // confirm the currency by eye faster than re-reading the whole invoice.
  const symbolAmountMatch = foundAmounts.find(
    f => f.currency === null && toCents(f.amount) === toCents(lc.amount)
  );
  if (symbolAmountMatch) {
    result.amountMatch = "match_currency_unconfirmed";
    result.matchedEntry = symbolAmountMatch;
    return result;
  }

  result.amountMatch = "mismatch";
  // Surface the closest same-currency candidate, if any, so the UI
  // can show what WAS found instead of just "no match"
  const sameCurrency = foundAmounts.filter(f => f.currency === lc.currency);
  result.matchedEntry = sameCurrency.length ? sameCurrency[0] : foundAmounts[0];
  return result;
}


if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseLcAmount,
    extractInvoiceAmounts,
    extractInvoiceDate,
    compareInvoiceToLc
  };
}
