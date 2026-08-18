// Pure extraction logic — no DOM, no chrome.* APIs.
//
// Split out of content.js so the regex/parsing layer can be unit-tested
// under Node (see test/extract.test.js). Loaded as the first content
// script in the isolated world, where it assigns itself to globalThis;
// content.js then calls it as `VDPExtract.*`.

(function (root, factory) {
  const api = factory();
  root.VDPExtract = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // ---------- shared text helpers ----------

  function getSentences(text) {
    return String(text)
      // Vrbo's "About this property" blob arrives from Apollo as raw HTML
      // with <br> as its ONLY separator and no newlines at all (measured
      // live: 1869 chars, 44 <br>, 0 \n). Without this the whole blob is
      // one "sentence", blows past the 400-char cap below, and is dropped
      // entirely — and any fragment that did survive carried visible
      // "<br><br>" into the panel.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0 && s.length < 400);
  }

  function isPetRelated(s) {
    if (/traveling with pets|only properties that allow pets/i.test(s)) return false;
    return /\b(pets?|dogs?|canines?)\b/i.test(s);
  }

  // ---------- corpus assembly ----------

  // Priority order (higher = trusted first): a dedicated "Pets" row under
  // House Rules or Amenities is most reliable; freeform notes and the
  // About-property description come next; visible DOM text is the
  // catch-all fallback.
  function priorityForItem(item) {
    if (/^pets?$/i.test(item.header || "")) return 5;
    if (/house rules \/ policies/i.test(item.section || "")) return 4;
    if (/about this property/i.test(item.section || "")) return 3;
    return 2;
  }

  // domSentences: already-filtered pet-relevant sentences scraped from the
  // rendered page, passed in by the caller so this stays DOM-free.
  function buildCorpus(apolloPayload, domSentences) {
    const bucket = []; // { text, source, priority }
    if (apolloPayload && Array.isArray(apolloPayload.items)) {
      // Items explicitly categorized under a "Pets" header by Vrbo/the
      // host are trusted wholesale — a sentence like "No aggressive
      // breeds or pit bulls" is clearly pet-relevant in that context even
      // though it doesn't literally contain the word "pet" or "dog", so
      // we don't want the generic keyword filter to drop it. Everything
      // else (About-property prose, freeform notes, DOM fallback) is a
      // mixed-topic blob, so it still needs the keyword filter to avoid
      // pulling in unrelated sentences.
      const isDedicatedPetsHeader = (it) => /^pets?$/i.test(it.header || "");
      const petItems = apolloPayload.items.filter((it) => isDedicatedPetsHeader(it) || /\b(pets?|dogs?)\b/i.test(it.text));
      for (const it of petItems) {
        const priority = priorityForItem(it);
        const trustWholesale = isDedicatedPetsHeader(it);
        // Vrbo emits the section label as its own value, so the amenities
        // "Pets" row yields a literal "Pets" string. It carries no
        // information and was showing up as an "Other pet note" on every
        // single listing.
        if ((it.text || "").trim().toLowerCase() === (it.header || "").trim().toLowerCase()) continue;
        for (const sentence of getSentences(it.text)) {
          if (trustWholesale || isPetRelated(sentence)) {
            bucket.push({ text: sentence, source: it.section || it.header || "Listing data", priority });
          }
        }
      }
    }
    for (const sentence of domSentences || []) {
      bucket.push({ text: sentence, source: "Visible page text", priority: 1 });
    }

    // De-dupe by normalized text, keeping the highest-priority occurrence.
    const byText = new Map();
    for (const entry of bucket) {
      const key = entry.text.toLowerCase();
      const existing = byText.get(key);
      if (!existing || entry.priority > existing.priority) byText.set(key, entry);
    }
    return Array.from(byText.values()).sort((a, b) => b.priority - a.priority);
  }

  // ---------- pattern building blocks ----------

  const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const NUM = `(?<num>\\d+|${Object.keys(WORD_NUMS).join("|")})`;

  // Every polarity/limit pattern accepts "dog" wherever it accepts "pet".
  // Hosts write both interchangeably ("No dogs allowed", "Dogs welcome"),
  // and matching only "pet" silently dropped those listings to "unknown".
  const PET = "(?:pets?|dogs?|canines?)";

  // Weight is only meaningful with its unit attached: the manifest claims
  // fewo-direkt.de / abritel.fr / stayz.com.au, and those listings quote kg.
  const WEIGHT_UNIT = "(?<unit>lbs?\\.?|pounds?|kgs?\\.?|kilos?|kilograms?)";

  // Longer symbols first so "AU$50" isn't read as a bare "$" match.
  const CUR = "(?<cur>AU\\$|NZ\\$|CA\\$|US\\$|A\\$|\\$|€|£|USD|EUR|GBP|AUD|NZD)";
  const AMT = "(?<amt>\\d{1,4}(?:[.,]\\d{2})?)";

  function toNumber(numStr) {
    const lower = String(numStr).toLowerCase();
    if (WORD_NUMS[lower] !== undefined) return WORD_NUMS[lower];
    return parseInt(numStr, 10);
  }

  const CURRENCY_DISPLAY = { USD: "$", EUR: "€", GBP: "£", AUD: "A$", NZD: "NZ$", CAD: "CA$" };

  function formatMoney(cur, amt) {
    const symbol = CURRENCY_DISPLAY[String(cur).toUpperCase()] || cur;
    // European listings write "50,00 €" — normalize the decimal comma so
    // the panel doesn't show a value that reads as a thousands separator.
    return `${symbol}${String(amt).replace(",", ".")}`;
  }

  function isMetricUnit(unit) {
    return /^k/i.test(unit);
  }

  function formatWeight(amt, unit) {
    return `${amt} ${isMetricUnit(unit) ? "kg" : "lbs"}`;
  }

  // "50 lbs" and "23 kg" are the same limit stated twice, not a listing
  // contradicting itself — normalize before deciding whether to warn.
  function weightToLbs(display) {
    const m = /^(\d+(?:\.\d+)?)\s*(lbs|kg)$/i.exec(String(display));
    if (!m) return null;
    const n = parseFloat(m[1]);
    return /kg/i.test(m[2]) ? n * 2.20462 : n;
  }

  function sameWeight(a, b) {
    const la = weightToLbs(a);
    const lb = weightToLbs(b);
    if (la === null || lb === null) return a === b;
    return Math.abs(la - lb) <= 2;
  }

  // ---------- extraction ----------

  function extractPolicy(entries) {
    // entries: [{ text, source, priority }, ...] already sorted by priority
    const result = {
      found: entries.length > 0,
      petsAllowed: null,
      petsAllowedSnippet: null,
      petsAllowedSource: null,
      maxDogs: null,
      maxDogsSnippet: null,
      maxDogsSource: null,
      maxDogsAlternates: [],
      weightPerDog: null,
      weightSnippet: null,
      weightSource: null,
      weightAlternates: [],
      preReg: null,
      preRegSnippet: null,
      preRegSource: null,
      fee: null,
      feeSnippet: null,
      feeSource: null,
      feeAlternates: [],
      noFeeMentioned: false,
      deposit: null,
      depositSnippet: null,
      depositSource: null,
      otherNotes: [], // [{text, source}] — pet-relevant sentences not used elsewhere
      entries,
    };

    // "No pets" etc., but NOT when it's actually a conditional restriction
    // like "no pets over 30 lbs" / "no pets without prior approval" —
    // those mean pets ARE allowed, just with a condition.
    //
    // The fee/deposit/charge exclusions matter just as much: "No pet fee"
    // is a dog-FRIENDLY statement, and without them it matched here and
    // rendered "Pets are not allowed" on a free, pet-welcoming listing.
    const NOT_ALLOWED_RE = new RegExp(
      `\\bno\\s+${PET}\\b(?!\\s*(?:over|above|larger|bigger|heavier|weighing|without|unless|except|fee|fees|deposit|deposits|charge|charges|surcharge))` +
        `|\\b${PET}\\s+(?:are\\s+)?not\\s+(?:allowed|permitted)\\b(?!\\s*(?:over|above|without|unless|except))` +
        `|\\b(?:pet|dog)[-\\s]?free\\b`,
      "i"
    );
    const ALLOWED_RE = new RegExp(`\\b${PET}\\s+(?:are\\s+)?(?:allowed|permitted|welcome|ok(?:ay)?)\\b|\\b(?:dog|pet)[-\\s]?friendly\\b`, "i");

    const MAX_DOGS_RE = [
      new RegExp(`\\b(?:up to|maximum(?:\\s+of)?|max\\.?|no more than|limit(?:ed)? to|limit of)\\s*${NUM}\\s*${PET}\\b`, "i"),
      new RegExp(`\\b${NUM}\\s*${PET}\\s*(?:max(?:imum)?|allowed|permitted|welcome|ok(?:ay)?|total)\\b`, "i"),
      new RegExp(`\\blimit\\s*${NUM}\\s*${PET}(?:\\s*total)?\\b`, "i"),
      // "Two Dogs up to 50lbs welcome" — the count leads and the
      // allowance word only arrives after an intervening weight clause,
      // so the qualifier can't be required adjacent to the noun. Bounded
      // to the same sentence and 40 characters so it stays a local claim.
      new RegExp(`\\b${NUM}\\s+${PET}\\b(?=[^.]{0,40}\\b(?:welcome|allowed|permitted|ok(?:ay)?)\\b)`, "i"),
      // "Pets allowed: dogs (limit 2 total)" — count without a repeated noun.
      new RegExp(`\\blimit(?:ed)?\\s*(?:to\\s*)?${NUM}\\s*total\\b`, "i"),
    ];

    const WEIGHT_RE = [
      new RegExp(`\\b(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\s*(?:per (?:dog|pet)|each|max(?:imum)?|or (?:less|under)|weight limit)\\b`, "i"),
      new RegExp(`\\bweight limit\\s*(?:of|is|:)?\\s*(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\b`, "i"),
      new RegExp(`\\b(?:up to|under|less than|max(?:imum)?(?:\\s+of)?)\\s*(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\b`, "i"),
      new RegExp(`\\bcombined weight of\\s*(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\b`, "i"),
    ];

    // "pre-registered" is the most common phrasing of this rule, so the
    // inflections have to be part of the alternative itself — a bare
    // "pre-?register" can't match it, since the \b lands on the "ed".
    const PREREG_RE = /\b(pre-?register(?:ed|ation|s)?|register(?:ed|ation)?\s+(?:your|the)?\s*pets?|must\s+be\s+(?:pre-?)?registered|registration\s+(?:is\s+)?required|notify\s+(?:the\s+)?(?:host|owner|property|management)|please\s+notify|let\s+us\s+know|inform\s+(?:the\s+)?(?:host|owner|property)|advance\s+notice|prior\s+(?:approval|permission|notice)|contact\s+(?:the\s+)?(?:host|owner|property)\s+(?:before|prior to)|must\s+be\s+approved|approval\s+(?:is\s+)?required)\b/i;

    const FEE_RE = [
      new RegExp(`${CUR}\\s?${AMT}\\s*(?:one[-\\s]?time|non[-\\s]?refundable)?\\s*(?:\\+\\s*tax\\s*)?(?:pet|dog)\\s*fee(?:\\s*per\\s*(?<per>night|stay|day))?`, "i"),
      new RegExp(`${AMT}\\s?${CUR}\\s*(?:one[-\\s]?time|non[-\\s]?refundable)?\\s*(?:\\+\\s*tax\\s*)?(?:pet|dog)\\s*fee(?:\\s*per\\s*(?<per>night|stay|day))?`, "i"),
      new RegExp(`(?:pet|dog)\\s*fee\\s*(?:of|is|:)?\\s*${CUR}\\s?${AMT}(?:\\s*per\\s*(?<per>night|stay|day))?`, "i"),
      new RegExp(`(?:pet|dog)\\s*fee\\s*(?:of|is|:)?\\s*${AMT}\\s?${CUR}(?:\\s*per\\s*(?<per>night|stay|day))?`, "i"),
      new RegExp(`${CUR}\\s?${AMT}\\s*per\\s*(?:pet|dog)(?:\\s*per\\s*(?<per>night|stay|day))?`, "i"),
      new RegExp(`${AMT}\\s?${CUR}\\s*per\\s*(?:pet|dog)(?:\\s*per\\s*(?<per>night|stay|day))?`, "i"),
    ];
    const NO_FEE_RE = new RegExp(`\\bno\\s+(?:additional\\s+)?(?:pet|dog)\\s*(?:fee|charge)s?\\b|\\b${PET}\\s+(?:stay\\s+)?free\\b`, "i");
    const DEPOSIT_RE = [
      new RegExp(`${CUR}\\s?${AMT}\\s*(?:refundable\\s*)?(?:pet|dog)\\s*deposit`, "i"),
      new RegExp(`${AMT}\\s?${CUR}\\s*(?:refundable\\s*)?(?:pet|dog)\\s*deposit`, "i"),
      new RegExp(`(?:pet|dog)\\s*deposit\\s*(?:of|is|:)?\\s*${CUR}\\s?${AMT}`, "i"),
      new RegExp(`(?:pet|dog)\\s*deposit\\s*(?:of|is|:)?\\s*${AMT}\\s?${CUR}`, "i"),
    ];

    function record(field, snippetField, sourceField, altField, value, entry, sameAs) {
      const eq = sameAs || ((a, b) => a === b);
      if (result[field] === null) {
        result[field] = value;
        result[snippetField] = entry.text;
        result[sourceField] = entry.source;
      } else if (!eq(result[field], value) && !result[altField].some((a) => eq(a.value, value))) {
        result[altField].push({ value, snippet: entry.text, source: entry.source });
      }
    }

    function firstMatch(patterns, s) {
      for (const re of patterns) {
        const m = s.match(re);
        if (m) return m;
      }
      return null;
    }

    for (const entry of entries) {
      const s = entry.text;
      let usedForField = false;

      if (result.petsAllowed === null) {
        if (NOT_ALLOWED_RE.test(s)) {
          result.petsAllowed = false;
          result.petsAllowedSnippet = s;
          result.petsAllowedSource = entry.source;
          usedForField = true;
        } else if (ALLOWED_RE.test(s)) {
          result.petsAllowed = true;
          result.petsAllowedSnippet = s;
          result.petsAllowedSource = entry.source;
          usedForField = true;
        }
      }

      const dogsMatch = firstMatch(MAX_DOGS_RE, s);
      if (dogsMatch) {
        record("maxDogs", "maxDogsSnippet", "maxDogsSource", "maxDogsAlternates", toNumber(dogsMatch.groups.num), entry);
        usedForField = true;
      }

      const weightMatch = firstMatch(WEIGHT_RE, s);
      if (weightMatch) {
        const value = formatWeight(weightMatch.groups.amt, weightMatch.groups.unit);
        record("weightPerDog", "weightSnippet", "weightSource", "weightAlternates", value, entry, sameWeight);
        usedForField = true;
      }

      if (PREREG_RE.test(s)) {
        if (result.preReg === null) {
          result.preReg = true;
          result.preRegSnippet = s;
          result.preRegSource = entry.source;
        }
        usedForField = true;
      }

      const feeMatch = firstMatch(FEE_RE, s);
      if (feeMatch) {
        const suffix = feeMatch.groups.per ? ` per ${feeMatch.groups.per}` : "";
        record("fee", "feeSnippet", "feeSource", "feeAlternates", `${formatMoney(feeMatch.groups.cur, feeMatch.groups.amt)}${suffix}`, entry);
        usedForField = true;
      }

      if (NO_FEE_RE.test(s)) {
        if (!result.noFeeMentioned) {
          result.noFeeMentioned = true;
          if (!result.feeSnippet) {
            result.feeSnippet = s;
            result.feeSource = entry.source;
          }
        }
        usedForField = true;
      }

      const depMatch = firstMatch(DEPOSIT_RE, s);
      if (depMatch && result.deposit === null) {
        result.deposit = formatMoney(depMatch.groups.cur, depMatch.groups.amt);
        result.depositSnippet = s;
        result.depositSource = entry.source;
        usedForField = true;
      }

      if (!usedForField) {
        result.otherNotes.push({ text: s, source: entry.source });
      }
    }

    if (result.fee === null && result.noFeeMentioned) {
      result.fee = "No fee mentioned";
    }

    // Cap and de-dupe other notes.
    const seenNotes = new Set();
    result.otherNotes = result.otherNotes
      .filter((n) => {
        const key = n.text.toLowerCase();
        if (seenNotes.has(key)) return false;
        seenNotes.add(key);
        return true;
      })
      .slice(0, 6);

    return result;
  }

  const CURRENCY_MAP = {
    "$": "USD",
    "US$": "USD",
    "USD": "USD",
    "€": "EUR",
    "EUR": "EUR",
    "£": "GBP",
    "GBP": "GBP",
    "¥": "JPY",
    "JPY": "JPY",
    "A$": "AUD",
    "AU$": "AUD",
    "AUD": "AUD",
    "CA$": "CAD",
    "C$": "CAD",
    "CAD": "CAD",
    "NZ$": "NZD",
    "NZD": "NZD",
  };

  function normalizeCurrencyCode(symbolOrCode) {
    if (!symbolOrCode) return "USD";
    const clean = String(symbolOrCode).trim().toUpperCase();
    return CURRENCY_MAP[symbolOrCode] || CURRENCY_MAP[clean] || clean;
  }

  function formatCurrencyDisplay(amount, currency = "USD") {
    if (typeof amount !== "number") return "";
    const code = normalizeCurrencyCode(currency);
    const symbolMap = {
      USD: "$",
      EUR: "€",
      GBP: "£",
      JPY: "¥",
      AUD: "A$",
      CAD: "CA$",
      NZD: "NZ$",
    };
    const sym = symbolMap[code] || `${code} `;
    return `${sym}${amount}`;
  }

  function normalizePolicy(extracted, propertyId = null, source = "search-response") {
    if (!extracted) return null;

    // 1. Weight limit normalization
    let weightLimit = null;
    if (extracted.weightPerDog) {
      const wm = String(extracted.weightPerDog).match(/(\d+(?:\.\d+)?)\s*(lbs?|kg)/i);
      if (wm) {
        const val = parseFloat(wm[1]);
        const isKg = /kg/i.test(wm[2]);
        const unit = isKg ? "kg" : "lb";
        const pounds = isKg ? val * 2.20462262 : val;
        weightLimit = { value: val, unit, pounds };
      }
    }

    // 2. Fee normalization
    let fee = null;
    if (extracted.fee && extracted.fee !== "No fee mentioned") {
      const fm = String(extracted.fee).match(/(?:([A-Z]{1,3}\$|[$€£¥A-Z]{1,3}))?\s*(\d+(?:\.\d+)?)\s*(?:per\s+(stay|night|pet|day))?/i);
      if (fm) {
        const curSym = fm[1] || "$";
        const currency = normalizeCurrencyCode(curSym);
        const amount = parseFloat(fm[2]);
        const period = fm[3] ? (fm[3].toLowerCase() === "day" ? "night" : fm[3].toLowerCase()) : "unknown";
        fee = { amount, currency, period };
      }
    } else if (extracted.noFeeMentioned) {
      fee = { amount: 0, currency: "USD", period: "unknown" };
    }

    // 3. Deposit normalization
    let deposit = null;
    if (extracted.deposit) {
      const dm = String(extracted.deposit).match(/(?:([A-Z]{1,3}\$|[$€£¥A-Z]{1,3}))?\s*(\d+(?:\.\d+)?)/i);
      if (dm) {
        const curSym = dm[1] || "$";
        const currency = normalizeCurrencyCode(curSym);
        const amount = parseFloat(dm[2]);
        deposit = { amount, currency };
      }
    }

    // 4. Notes-only restrictions tracking
    const otherNotes = Array.isArray(extracted.otherNotes) ? extracted.otherNotes : [];
    const restrictionNoteCount = otherNotes.length;
    const restrictionsFound = Boolean(
      extracted.preReg ||
      restrictionNoteCount > 0 ||
      weightLimit ||
      fee ||
      extracted.maxDogs ||
      extracted.petsAllowed === true
    );

    // 5. Contradictions mapping
    const contradictions = {
      maxDogs: Boolean(extracted.maxDogsAlternates && extracted.maxDogsAlternates.length > 0),
      weightLimit: Boolean(extracted.weightAlternates && extracted.weightAlternates.length > 0),
      fee: Boolean(extracted.feeAlternates && extracted.feeAlternates.length > 0),
    };

    // 6. Confidence rating
    let confidence = "low";
    if (extracted.petsAllowed !== null) {
      confidence = (weightLimit || fee || extracted.maxDogs) ? "high" : "medium";
    } else if (extracted.preReg || restrictionNoteCount > 0) {
      confidence = "medium";
    }

    return {
      schemaVersion: 1,
      propertyId,
      source,
      extractedAt: new Date().toISOString(),
      petsAllowed: extracted.petsAllowed,
      maxDogs: extracted.maxDogs,
      weightLimit,
      fee,
      deposit,
      approvalRequired: extracted.preReg ? true : (extracted.preReg === false ? false : null),
      restrictionsFound,
      restrictionNoteCount,
      contradictions,
      confidence,
      _raw: extracted,
    };
  }

  function deriveSearchBadge(canonical) {
    if (!canonical) {
      return {
        statusKey: "loading",
        icon: "⏳",
        text: "Checking pet policy...",
        className: "vdp-search-badge vdp-badge-loading",
      };
    }

    if (canonical.status && canonical.status !== "ok") {
      return {
        statusKey: "unknown",
        icon: "🐾",
        text: "Check pet rules on listing",
        className: "vdp-search-badge vdp-badge-unknown",
      };
    }

    const policy = canonical.policy || canonical;

    if (!policy || (policy.petsAllowed === null && !policy.restrictionsFound && !policy.weightLimit && !policy.fee && !policy.maxDogs && !policy.approvalRequired && !policy.restrictionNoteCount)) {
      return {
        statusKey: "unknown",
        icon: "🐾",
        text: "Check pet rules on listing",
        className: "vdp-search-badge vdp-badge-unknown",
      };
    }

    if (policy.petsAllowed === false) {
      return {
        statusKey: "banned",
        icon: "🚫",
        text: "Pets not allowed",
        className: "vdp-search-badge vdp-badge-banned",
      };
    }

    if (policy.petsAllowed === true) {
      const details = [];
      if (policy.maxDogs) details.push(`Max ${policy.maxDogs}`);
      if (policy.weightLimit) {
        const valStr = Number.isInteger(policy.weightLimit.value)
          ? String(policy.weightLimit.value)
          : String(policy.weightLimit.value);
        const unitStr = policy.weightLimit.unit === "lb" ? "lbs" : policy.weightLimit.unit;
        details.push(`${valStr} ${unitStr}`);
      }
      if (policy.fee && policy.fee.amount > 0) details.push(`${formatCurrencyDisplay(policy.fee.amount, policy.fee.currency)} pet fee`);
      if (policy.approvalRequired && details.length < 2) details.push("Approval required");

      const detailStr = details.length ? ` · ${details.slice(0, 2).join(" · ")}` : "";
      return {
        statusKey: "allowed",
        icon: "🐾",
        text: `Dogs allowed${detailStr}`,
        className: "vdp-search-badge vdp-badge-allowed",
      };
    }

    if (policy.approvalRequired === true) {
      return {
        statusKey: "restrictions",
        icon: "🐾",
        text: "Pet restrictions · Approval required",
        className: "vdp-search-badge vdp-badge-restrictions",
      };
    }

    if (policy.restrictionsFound || policy.weightLimit || policy.fee || policy.maxDogs || policy.restrictionNoteCount > 0) {
      return {
        statusKey: "restrictions",
        icon: "🐾",
        text: "Pet restrictions found",
        className: "vdp-search-badge vdp-badge-restrictions",
      };
    }

    return {
      statusKey: "unknown",
      icon: "🐾",
      text: "Check pet rules on listing",
      className: "vdp-search-badge vdp-badge-unknown",
    };
  }

  return {
    getSentences,
    isPetRelated,
    priorityForItem,
    buildCorpus,
    extractPolicy,
    normalizePolicy,
    deriveSearchBadge,
    toNumber,
    formatMoney,
    formatWeight,
  };
});
