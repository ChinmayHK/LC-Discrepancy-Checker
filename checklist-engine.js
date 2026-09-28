// ==============================================================================
// checklist-engine.js
// LCDC Phase 3 — Document classification + checklist logic
//
// Stage 1 of build: document type alias table + 46A splitter/classifier.
// Tier 1/2/3 check logic (per document type) comes next, once this stage
// is verified against real samples.
// ==============================================================================

// ---- Canonical document types ----
// Each type has:
//   id           - stable internal key
//   label        - what the UI shows
//   aliases      - keyword/phrase patterns used to classify a 46A line item
//                  (lowercase, matched against lowercased line text)
//   fieldRef     - which MT700 field this doc type is most often cross-checked against
//                  (used later for Tier 1/2 checks, not used in classification itself)
const DOCUMENT_TYPES = [
  {
    id: "invoice",
    label: "Commercial Invoice",
    // Deliberately NOT including a bare "invoice" alias — it's too generic
    // and false-matches inside unrelated phrases like "invoice value" or
    // "invoice amount" that appear in other documents' descriptions
    // (e.g. an insurance clause covering "110 pct of invoice value").
    // Anything not matching one of these more specific phrases falls
    // through to "unrecognized" for manual review instead of guessing.
    aliases: [
      "commercial invoice", "signed invoice", "invoice in triplicate",
      "invoice in duplicate", "invoice in original", "original invoice"
    ],
    fieldRef: "45A"
  },
  {
    id: "bill_of_lading",
    label: "Bill of Lading",
    // "bl " (with trailing space) deliberately excluded — too short and
    // risks matching inside unrelated words. "b/l" kept since the slash
    // makes it distinctive enough to be safe.
    aliases: [
      "bill of lading", "b/l", "on board bill", "clean on board",
      "shipped on board", "ocean bill of lading"
    ],
    fieldRef: "44E"
  },
  {
    id: "airway_bill",
    label: "Air Waybill",
    aliases: ["airway bill", "air waybill", "awb"],
    fieldRef: "44E"
  },
  {
    id: "packing_list",
    label: "Packing List",
    aliases: ["packing list", "packing note"],
    fieldRef: "45A"
  },
  {
    id: "certificate_of_origin",
    label: "Certificate of Origin",
    // Bare "coo" deliberately excluded — a 3-letter substring is too risky
    // (could false-match inside other words). Only the full phrases are used.
    aliases: ["certificate of origin", "country of origin certificate"],
    fieldRef: "44F"
  },
  {
    id: "insurance",
    label: "Insurance",
    aliases: [
      "insurance policy", "insurance certificate", "insurance cover",
      "institute cargo clause", "marine insurance"
    ],
    fieldRef: "45A"
  },
  {
    id: "bill_of_exchange",
    label: "Bill of Exchange / Draft",
    aliases: ["bill of exchange", "draft at", "draft drawn"],
    fieldRef: "42C"
  },
  {
    id: "inspection_certificate",
    label: "Inspection Certificate",
    aliases: ["inspection certificate", "certificate of inspection", "survey report"],
    fieldRef: "45A"
  },
  {
    id: "beneficiary_certificate",
    label: "Beneficiary's Certificate",
    aliases: ["beneficiary certificate", "beneficiary's certificate", "beneficiary declaration"],
    fieldRef: null
  },
  {
    id: "weight_certificate",
    label: "Weight/Measurement Certificate",
    aliases: ["weight certificate", "certificate of weight", "measurement certificate"],
    fieldRef: "45A"
  }
];

// Build a flat lookup once: [{ type, alias }] sorted by alias length descending
// so longer/more specific phrases match before short generic ones
// (e.g. "certificate of origin" should win over a bare "certificate" if that
// were ever added).
const ALIAS_INDEX = DOCUMENT_TYPES
  .flatMap(type => type.aliases.map(alias => ({ type, alias })))
  .sort((a, b) => b.alias.length - a.alias.length);


// ------------------------------------------------------------------
// splitDocumentsRequired(raw46A)
//
// Splits the raw 46A field text into individual requirement line items.
// Handles the common real-world patterns:
//   1. Numbered list: "1. FOO\n2. BAR"
//   2. Line-wrapped items (continuation lines with no number, folded into
//      the previous item)
//   3. Fallback: if no numbering is detected at all, treat the whole
//      field as one single item (better than silently dropping it).
//
// Returns: array of strings, one per logical requirement, whitespace
// normalized (newlines within an item collapsed to single spaces).
// ------------------------------------------------------------------
function splitDocumentsRequired(raw46A) {
  if (!raw46A || !raw46A.trim()) return [];

  const lines = raw46A.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // Detect numbered-list pattern: a line starting with "N." or "N)" or "(N)"
  const numberedLineRegex = /^(\d{1,2})[\.\)]\s*/;

  const items = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(numberedLineRegex);
    if (match) {
      // Starts a new numbered item — push whatever was being built, start fresh
      if (current !== null) items.push(current.trim());
      current = line.replace(numberedLineRegex, "").trim();
    } else if (current !== null) {
      // Continuation of the current numbered item (wrapped line)
      current += " " + line;
    } else {
      // No numbering seen yet — start an implicit first item
      current = line;
    }
  }
  if (current !== null) items.push(current.trim());

  // Collapse any internal whitespace runs
  return items.map(item => item.replace(/\s+/g, " ").trim());
}


// ------------------------------------------------------------------
// classifyDocumentItem(itemText)
//
// Matches one requirement line item against the DOCUMENT_TYPES alias
// index. A single item can legitimately mention more than one document
// type — this happens whenever a 46A block has no numbering and several
// requirements are folded into one prose sentence (e.g. "invoice, bill
// of lading and certificate of origin"). Returning only the first hit
// would silently under-report the checklist, so this returns ALL
// distinct document types found in the item, not just one.
//
// Returns:
//   { matched: true, matches: [{ type, matchedAlias }, ...] }
//   { matched: false, matches: [] }
//
// Matching is deliberately simple substring matching for Stage 1 —
// this is the part that will need fuzzball.js token_set_ratio once
// real CA samples are available to calibrate a similarity threshold
// for messier/less standard wording. Substring matching is a safe,
// conservative starting point: it will under-match (surface more
// "review manually" items) rather than over-match and misclassify.
// ------------------------------------------------------------------
function classifyDocumentItem(itemText) {
  const lower = itemText.toLowerCase();
  const seenTypeIds = new Set();
  const matches = [];

  for (const { type, alias } of ALIAS_INDEX) {
    if (seenTypeIds.has(type.id)) continue; // already matched this type via a longer alias
    if (lower.includes(alias)) {
      matches.push({ type, matchedAlias: alias });
      seenTypeIds.add(type.id);
    }
  }

  return { matched: matches.length > 0, matches };
}


// ------------------------------------------------------------------
// buildDocumentChecklist(raw46A)
//
// Top-level entry point for Stage 1. Splits + classifies the full 46A
// field and returns a structure ready to drive the collapsible UI:
//
//   {
//     recognized: [
//       { docTypeId, label, sourceText, matchedAlias }
//     ],
//     unrecognized: [
//       { sourceText }   // couldn't classify — surfaced for manual review,
//                          never silently dropped
//     ]
//   }
//
// Note: if the same document type appears more than once in 46A
// (rare, but happens — e.g. invoice mentioned twice with different
// copy counts), both entries are kept; de-duplication is a UI-layer
// decision, not something this function should decide silently.
// ------------------------------------------------------------------
function buildDocumentChecklist(raw46A) {
  const items = splitDocumentsRequired(raw46A);

  const recognized = [];
  const unrecognized = [];

  for (const item of items) {
    const result = classifyDocumentItem(item);
    if (result.matched) {
      for (const { type, matchedAlias } of result.matches) {
        recognized.push({
          docTypeId: type.id,
          label: type.label,
          sourceText: item,
          matchedAlias: matchedAlias
        });
      }
    } else {
      unrecognized.push({ sourceText: item });
    }
  }

  return { recognized, unrecognized };
}


// ------------------------------------------------------------------
// Exports (for use once this is wired into the main LCDC page, and
// for standalone testing in the meantime)
// ------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DOCUMENT_TYPES,
    splitDocumentsRequired,
    classifyDocumentItem,
    buildDocumentChecklist
  };
}
