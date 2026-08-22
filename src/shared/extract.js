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
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;|&#x27;/gi, "'")
      .replace(/&le;|&#8804;/gi, "≤")
      .replace(/&ge;|&#8805;/gi, "≥")
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
  function formatSourceLabel(section, header) {
    const s = (section || "").trim();
    const h = (header || "").trim();
    if (s && h && s.toLowerCase() !== h.toLowerCase() && !s.toLowerCase().includes(h.toLowerCase())) {
      return `${s} > ${h}`;
    }
    return s || h || "Listing data";
  }

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
      const isDedicatedPetsHeader = (it) => /^pets?$/i.test(it.header || "") || Boolean(it.isDedicatedPetsHeader || it.explicitPetContext);
      const petItems = apolloPayload.items.filter((it) => isDedicatedPetsHeader(it) || /\b(pets?|dogs?)\b/i.test(it.text));
      for (const it of petItems) {
        const priority = priorityForItem(it);
        const trustWholesale = isDedicatedPetsHeader(it);
        // Vrbo emits the section label as its own value, so the amenities
        // "Pets" row yields a literal "Pets" string. It carries no
        // information and was showing up as an "Other pet note" on every
        // single listing.
        if ((it.text || "").trim().toLowerCase() === (it.header || "").trim().toLowerCase()) continue;
        const source = formatSourceLabel(it.section, it.header);
        for (const sentence of getSentences(it.text)) {
          if (trustWholesale || isPetRelated(sentence)) {
            bucket.push({
              text: sentence,
              source,
              priority,
              isDedicatedPetsHeader: trustWholesale,
              explicitPetContext: trustWholesale,
            });
          }
        }
      }
    }
    for (const item of domSentences || []) {
      const sentence = typeof item === "string" ? item : item?.text;
      const source = (typeof item === "object" && item?.source) ? item.source : "Visible page text";
      const isExplicit = Boolean(item && typeof item === "object" && (item.isDedicatedPetsHeader || item.explicitPetContext));
      if (sentence && !/^(?:pets?|dogs?)$/i.test(sentence.trim())) {
        bucket.push({
          text: sentence,
          source,
          priority: isExplicit ? 4 : 1,
          isDedicatedPetsHeader: isExplicit,
          explicitPetContext: isExplicit,
        });
      }
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

  // Every polarity/limit pattern accepts "dog" wherever it accepts "pet",
  // as well as common compound phrasings like "dogs and cats", "dogs & cats", "cats and dogs".
  // Hosts write both interchangeably ("No dogs allowed", "Dogs welcome"),
  // and matching only "pet" silently dropped those listings to "unknown".
  const PET = "(?:pets?|dogs?(?:\\s*(?:and|&|or|\\/)\\s*cats?)?|canines?|cats?\\s*(?:and|&|or|\\/)\\s*dogs?)";

  // Weight is only meaningful with its unit attached: the manifest claims
  // fewo-direkt.de / abritel.fr / stayz.com.au, and those listings quote kg.
  const WEIGHT_UNIT = "(?<unit>lbs?\\.?|pounds?|pds?\\.?|kgs?\\.?|kilos?|kilograms?)";

  // Longer symbols first so "AU$50" isn't read as a bare "$" match.
  const CUR = "(?<cur>AU\\$|NZ\\$|CA\\$|US\\$|A\\$|\\$|€|£|USD|EUR|GBP|AUD|NZD)";
  // Three shapes, tried in this order so the more specific ones aren't
  // shadowed by the plain-number fallback:
  //   1. US-style thousands grouping, optional cents: "1,000", "12,500.00", "1,234,567"
  //   2. European decimal comma, no thousands grouping: "50,00", "50,45"
  //   3. Plain amount, period decimal or none: "50", "999", "1250.50"
  // A bare `\d{1,4}(?:[.,]\d{2})?` can't tell "1,000" (thousands) apart from
  // "50,00" (decimal) — it happily eats a lone "," as either — and even when
  // it does match "1,000" whole, a leading `\b` upstream of this group can't
  // anchor right after the "$" in "$1,000" (both the space before and the
  // "$" are non-word characters), so the engine backtracks past "1," entirely
  // and matches the bare "000" instead. Disambiguating by digit-group shape
  // here removes that ambiguity before the surrounding `\b` ever gets a
  // chance to go looking for a fallback match.
  //
  // The decimal-comma shape has to come before the plain fallback, not
  // after: alternation tries branches left-to-right and stops at the first
  // one that lets the rest of the surrounding pattern succeed, so whenever
  // nothing mandatory follows the amount (e.g. "€50,45." with only
  // optional suffix groups left in the pattern), a plain `\d+` tried first
  // would already satisfy the rest of the match on "50" alone and the
  // engine would never backtrack to try the fuller ",45" alternative.
  const AMT =
    "(?<amt>\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\d+,\\d{2}|\\d+(?:\\.\\d{2})?)";

  function toNumber(numStr) {
    const lower = String(numStr).toLowerCase();
    if (WORD_NUMS[lower] !== undefined) return WORD_NUMS[lower];
    return parseInt(numStr, 10);
  }

  const CURRENCY_DISPLAY = { USD: "$", EUR: "€", GBP: "£", AUD: "A$", NZD: "NZ$", CAD: "CA$" };

  function formatMoney(cur, amt) {
    const symbol = CURRENCY_DISPLAY[String(cur).toUpperCase()] || cur;
    const amtStr = String(amt);
    // The AMT pattern's two comma shapes mean opposite things, so a blind
    // comma->period replace can't handle both: a European decimal comma
    // ("50,00", exactly two trailing digits and nothing else) normalizes to
    // a period; anything else with a comma is a US-style thousands
    // separator ("1,000", "12,500.00", "1,234,567") and the comma is just
    // dropped so downstream numeric parsing sees a plain integer/decimal.
    const normalized = /^\d+,\d{2}$/.test(amtStr) ? amtStr.replace(",", ".") : amtStr.replace(/,/g, "");
    return `${symbol}${normalized}`;
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

  function cleanEntryText(text) {
    if (!text || typeof text !== "string") return "";
    return text
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;|&#x27;/gi, "'")
      .replace(/&le;|&#8804;/gi, "≤")
      .replace(/&ge;|&#8805;/gi, "≥")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- pattern definitions (hoisted to module scope) ----------

  // "No pets" etc., but NOT when it's actually a conditional restriction
  // like "no pets over 30 lbs" / "no pets without prior approval" —
  // those mean pets ARE allowed, just with a condition.
  //
  // The fee/deposit/charge exclusions matter just as much: "No pet fee"
  // is a dog-FRIENDLY statement, and without them it matched here and
  // rendered "Pets are not allowed" on a free, pet-welcoming listing.
  const NOT_ALLOWED_RE = new RegExp(
    `\\bno\\s+${PET}\\b(?!\\s*(?:over|above|larger|bigger|heavier|weighing|without|unless|except|fee|fees|deposit|deposits|charge|charges|surcharge))` +
      `|\\b${PET}\\s+(?:(?:are|is)\\s+)?not\\s+(?:allowed|permitted)\\b(?!\\s*(?:over|above|without|unless|except))` +
      `|\\b(?:pet|dog)[-\\s]?free\\b`,
    "i"
  );
  const ALLOWED_RE = new RegExp(
    `\\b${PET}\\s+(?:(?:are|is)\\s+)?(?:allowed|permitted|welcome|ok(?:ay)?)\\b` +
    `|\\b(?:dog|pet)[-\\s]?friendly\\b` +
    `|\\b(?:allows?|permits?|welcomes?|accepts?)\\s+(?:up\\s+to\\s+)?(?:${NUM}\\s+)?${PET}\\b`,
    "i"
  );

  const MAX_DOGS_RE = [
    new RegExp(`\\b(?:up to|maximum(?:\\s+of)?|max\\.?|no more than|limit(?:ed)? to|limit of|allows?|permits?|welcomes?|accepts?)\\s*${NUM}\\s*${PET}(?!\\s*(?:fee|fees|deposit|deposits|charge|charges|surcharge|rate|rent))\\b`, "i"),
    new RegExp(`\\b${NUM}\\s*${PET}(?!\\s*(?:fee|fees|deposit|deposits|charge|charges|surcharge|rate|rent))\\s*(?:max(?:imum)?|allowed|permitted|welcome|ok(?:ay)?|total)\\b`, "i"),
    new RegExp(`\\blimit\\s*${NUM}\\s*${PET}(?!\\s*(?:fee|fees|deposit|deposits|charge|charges|surcharge|rate|rent))(?:\\s*total)?\\b`, "i"),
    // "Two Dogs up to 50lbs welcome", "2 dogs (under 50 lbs)", "2 dogs, 50 lbs max" —
    // the count leads and the qualifier or weight clause follows. Bounded
    // to the same sentence and 40 characters so it stays a local claim.
    new RegExp(`\\b${NUM}\\s+${PET}(?!\\s*(?:fee|fees|deposit|deposits|charge|charges|surcharge|rate|rent))\\b(?=[^.]{0,40}\\b(?:welcome|allowed|permitted|ok(?:ay)?|under|less than|up to|max(?:imum)?|lbs?|pounds?|pds?|kg|weight|limit)\\b)`, "i"),
    // "Pets allowed: dogs (limit 2 total)" — count without a repeated noun.
    new RegExp(`\\blimit(?:ed)?\\s*(?:to\\s*)?${NUM}\\s*total\\b`, "i"),
  ];

  const WEIGHT_RE = [
    new RegExp(`\\b(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\s*(?:per (?:dog|pet)|each|max(?:imum)?|or (?:less|under)|weight limit)\\b`, "i"),
    new RegExp(`\\bweight(?:\\s+limit)?\\s*(?:of|is|:|<|<=|≤)?\\s*(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\b`, "i"),
    new RegExp(`\\b(?:up to|under|less than|max(?:imum)?(?:\\s+of)?|<|<=|≤)\\s*(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\b`, "i"),
    new RegExp(`\\bcombined weight of\\s*(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}\\b`, "i"),
  ];

  // "pre-registered" is the most common phrasing of this rule, so the
  // inflections have to be part of the alternative itself — a bare
  // "pre-?register" can't match it, since the \b lands on the "ed".
  const PREREG_RE = /\b(pre-?register(?:ed|ation|s)?|register(?:ed|ation)?\s+(?:your|the)?\s*pets?|must\s+be\s+(?:pre-?)?registered|registration\s+(?:is\s+)?required|must\s+be\s+declared|declare\s+(?:your|the)?\s*pets?|declaration\s+(?:is\s+)?required|include\s+(?:your\s+)?pets?\s+(?:when|in\s+(?:your\s+)?(?:booking|reservation|inquiry|message|count|telling))|tell\s+us\s+(?:about\s+)?(?:your\s+)?pets?|notify\s+(?:the\s+)?(?:host|owner|property|management)|please\s+notify|let\s+us\s+know|inform\s+(?:the\s+)?(?:host|owner|property)|advance\s+notice|prior\s+(?:approval|permission|notice)|contact\s+(?:the\s+)?(?:host|owner|property)\s+(?:before|prior to)|must\s+be\s+approved|approval\s+(?:is\s+)?required)\b/i;

  const TIERED_FEE_RE = new RegExp(
    `(?:(?:one|1|first|1st)\\s+${PET}\\s+(?:(?:is|are)\\s+)?(?:allowed\\s+(?:at\\s+)?no\\s+(?:additional\\s+)?(?:cost|fee|charge)|(?:(?:is|are)\\s+)?free))` +
    `[,;\\s]+(?:each\\s+)?(?:subsequent|additional|extra|further|other|2nd|second)\\s+${PET}\\s+(?:(?:is|are)\\s+)?` +
    `${CUR}?\\s?${AMT}\\s*(?:each)?(?:\\s*(?:/|per\\s*)(?<target>pet|dog|each))?(?:\\s*(?:/|per\\s*)(?<time>night|stay|day))?`,
    "i"
  );

  const FEE_RE = [
    new RegExp(`\\b(?:a\\s+)?(?:${CUR}\\s?${AMT}|${AMT}\\s?${CUR}|${AMT})\\s*(?:one[-\\s]?time|non[-\\s]?refundable)?\\s*(?:\\+\\s*tax\\s*)?(?:pet|dog)\\s*fee(?:\\s*(?:for\\s+(?:the\\s+)?(?:whole\\s+trip|entire\\s+stay|stay)|(?:/|per\\s*)(?<target>pet|dog|each))?,?\\s*(?:(?:/|per\\s*)(?<time>night|stay|day))?)?`, "i"),
    new RegExp(`(?:(?:pet|dog|additional|extra)\\s+)?fee(?:\\s*(?:of|is|:))?\\s*${AMT}\\s?${CUR}\\s*(?:(?:/|per\\s*)(?<target>pet|dog|each))?,?\\s*(?:(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
    new RegExp(`(?:(?:pet|dog|additional|extra)\\s+)?fee(?:\\s*(?:of|is|:))?\\s*${CUR}\\s?${AMT}\\s*(?:(?:/|per\\s*)(?<target>pet|dog|each))?,?\\s*(?:(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
    new RegExp(`${CUR}\\s?${AMT}\\s*(?:one[-\\s]?time|non[-\\s]?refundable)?\\s*(?:\\+\\s*tax\\s*)?(?:(?:pet|dog|additional|extra)\\s+)?fee(?:\\s*(?:of|is|:))?\\s*(?:(?:/|per\\s*)(?<target>pet|dog|each))?,?\\s*(?:(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
    new RegExp(`${AMT}\\s?${CUR}\\s*(?:one[-\\s]?time|non[-\\s]?refundable)?\\s*(?:\\+\\s*tax\\s*)?(?:(?:pet|dog|additional|extra)\\s+)?fee(?:\\s*(?:of|is|:))?\\s*(?:(?:/|per\\s*)(?<target>pet|dog|each))?,?\\s*(?:(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
    new RegExp(`${CUR}\\s?${AMT}\\s*(?:/|per\\s*)(?<target>pet|dog|each)(?:,?\\s*(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
    new RegExp(`${AMT}\\s?${CUR}\\s*(?:/|per\\s*)(?<target>pet|dog|each)(?:,?\\s*(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
    new RegExp(`${CUR}\\s?${AMT}\\s*(?:/|per\\s*)(?<time>night|stay|day)(?:\\s*(?:/|per\\s*)(?<target>pet|dog|each))?`, "i"),
    new RegExp(`${AMT}\\s?${CUR}\\s*(?:/|per\\s*)(?<time>night|stay|day)(?:\\s*(?:/|per\\s*)(?<target>pet|dog|each))?`, "i"),
    new RegExp(`${CUR}\\s?${AMT}\\s*(?:flat|total)?\\s*(?:fee)?\\s*(?:per\\s+stay)?\\s*(?:for\\s+(?:the\\s+)?(?:maximum|all|up\\s+to\\s+\\d+)?\\s*(?:allowed\\s+)?(?:pets?|dogs?))`, "i"),
    new RegExp(`(?:(?:pet|dog|additional|extra)\\s+)?fee(?:\\s*(?:of|is|:))?\\s*${AMT}\\s*(?:(?:/|per\\s*)(?<target>pet|dog|each))?,?\\s*(?:(?:/|per\\s*)(?<time>night|stay|day))?`, "i"),
  ];
  const RELAXED_MAX_DOGS_RE = [
    new RegExp(`^(?:max(?:imum)?|limit)?:?\\s*${NUM}(?:\\s*(?:pets?|dogs?))?$`, "i"),
  ];

  const RELAXED_WEIGHT_RE = [
    new RegExp(`^(?:weight(?:\\s+limit)?:?\\s*)?(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}$`, "i"),
    new RegExp(`^(?:max(?:imum)?:?\\s*)?(?<amt>\\d{1,3})\\s*${WEIGHT_UNIT}$`, "i"),
  ];

  const RELAXED_FEE_RE = [
    new RegExp(`^(?:fee:?\\s*)?${CUR}\\s?${AMT}(?:\\s*(?:/|per\\s*)(?<target>pet|dog|each))?(?:,?\\s*(?:/|per\\s*)(?<time>night|stay|day))?$`, "i"),
    new RegExp(`^${AMT}\\s?${CUR}(?:\\s*(?:/|per\\s*)(?<target>pet|dog|each))?(?:,?\\s*(?:/|per\\s*)(?<time>night|stay|day))?$`, "i"),
    new RegExp(`^(?:pet|dog)?\\s*fee:?\\s*${CUR}\\s?${AMT}`, "i"),
  ];

  const UNPRICED_FEE_RE = /\b(there\s+is\s+(?:a\s+)?(?:one[-\s]?time\s+|non[-\s]?refundable\s+)?(?:pet|dog)\s+fee|(?:pet|dog)\s+fee\s+(?:is\s+)?(?:paid|applies|required|charged|due|applicable|assessed)|(?:pet|dog)\s+fees?\s+apply|the\s+(?:pet|dog)\s+fee\s+paid|(?:subject\s+to|requires?|incurs?)\s+(?:a\s+)?(?:pet|dog)\s+fee|(?:additional\s+)?(?:pet|dog)\s+fee\s+applies|fee\s+applies\s+for\s+pets?)\b/i;
  const NO_FEE_RE = new RegExp(`\\bno\\s+(?:additional\\s+)?(?:pet|dog)\\s*(?:fee|charge)s?\\b|\\b${PET}\\s+(?:stay\\s+)?free\\b`, "i");
  const DEPOSIT_RE = [
    new RegExp(`${CUR}\\s?${AMT}\\s*(?:refundable\\s*)?(?:pet|dog)\\s*deposit`, "i"),
    new RegExp(`${AMT}\\s?${CUR}\\s*(?:refundable\\s*)?(?:pet|dog)\\s*deposit`, "i"),
    new RegExp(`(?:pet|dog)\\s*deposit\\s*(?:of|is|:)?\\s*${CUR}\\s?${AMT}`, "i"),
    new RegExp(`(?:pet|dog)\\s*deposit\\s*(?:of|is|:)?\\s*${AMT}\\s?${CUR}`, "i"),
  ];

  function normalizeFeePhrasing(text) {
    if (!text || typeof text !== "string") return text;
    return text
      .replace(/\bper\s+each\s+(pet|dog)s?\b/gi, "per $1")
      .replace(/\beach\s+(pet|dog)s?\b/gi, "per $1");
  }

  function firstMatch(patterns, s) {
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return m;
    }
    return null;
  }

  // ---------- extraction ----------

  function extractPolicy(rawEntries) {
    // entries: [{ text, source, priority }, ...] already sorted by priority
    const entries = (rawEntries || []).map((e) => ({
      ...e,
      text: cleanEntryText(e?.text),
    })).filter((e) => Boolean(e.text));

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

      const feeNormalized = normalizeFeePhrasing(s);
      const tieredMatch = feeNormalized.match(TIERED_FEE_RE);

      const isExplicitContext = Boolean(entry.isDedicatedPetsHeader || entry.explicitPetContext || entry.priority >= 4);

      let dogsMatch = firstMatch(MAX_DOGS_RE, s);
      if (!dogsMatch && isExplicitContext) {
        dogsMatch = firstMatch(RELAXED_MAX_DOGS_RE, s);
      }
      if (dogsMatch) {
        const matchedNum = toNumber(dogsMatch.groups.num);
        // Suppress maxDogs only when TIERED_FEE_RE matched, the matched number is 1, and there is no explicit limit phrasing
        const isTieredOneDogFree = tieredMatch && matchedNum === 1 && !/\b(?:up to|maximum|max|limit(?:ed)?|no more than)\b/i.test(dogsMatch[0]);
        if (!isTieredOneDogFree) {
          record("maxDogs", "maxDogsSnippet", "maxDogsSource", "maxDogsAlternates", matchedNum, entry);
          usedForField = true;
        }
      }

      let weightMatch = firstMatch(WEIGHT_RE, s);
      if (!weightMatch && isExplicitContext) {
        weightMatch = firstMatch(RELAXED_WEIGHT_RE, s);
      }
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

      if (tieredMatch) {
        if (result.petsAllowed === null) {
          result.petsAllowed = true;
          result.petsAllowedSnippet = s;
          result.petsAllowedSource = entry.source;
        }
        const amtStr = formatMoney(tieredMatch.groups.cur || "$", tieredMatch.groups.amt);
        const time = tieredMatch.groups.time ? tieredMatch.groups.time.toLowerCase() : "stay";
        const feeStr = `$0 1st dog, ${amtStr} each subsequent dog per ${time}`;
        record("fee", "feeSnippet", "feeSource", "feeAlternates", feeStr, entry);
        usedForField = true;
      } else {
        let feeMatch = firstMatch(FEE_RE, feeNormalized);
        if (!feeMatch && isExplicitContext) {
          feeMatch = firstMatch(RELAXED_FEE_RE, feeNormalized);
        }
        if (feeMatch) {
          const target = feeMatch.groups.target ? (feeMatch.groups.target.toLowerCase() === "dog" ? "pet" : feeMatch.groups.target.toLowerCase()) : null;
          const time = feeMatch.groups.time ? feeMatch.groups.time.toLowerCase() : null;
          let suffix = "";
          if (target && time) {
            suffix = ` per ${target} per ${time}`;
          } else if (time) {
            suffix = ` per ${time}`;
          } else if (target) {
            suffix = ` per ${target}`;
          } else if (/per\s+stay/i.test(s)) {
            suffix = ` per stay`;
          }
          record("fee", "feeSnippet", "feeSource", "feeAlternates", `${formatMoney(feeMatch.groups.cur || "$", feeMatch.groups.amt)}${suffix}`, entry);
          usedForField = true;
        } else if (!result.fee && UNPRICED_FEE_RE.test(s)) {
          record("fee", "feeSnippet", "feeSource", "feeAlternates", "Pet fee applies", entry);
          usedForField = true;
        }
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

      if (!usedForField && !/^(?:pets?|dogs?)$/i.test(s.trim())) {
        result.otherNotes.push({ text: s, source: entry.source });
      }
    }

    if (result.fee === null && result.noFeeMentioned) {
      result.fee = "No fee mentioned";
    }

    if (result.petsAllowed === null && (result.maxDogs !== null || result.weightPerDog !== null || (result.fee !== null && result.fee !== "No pets allowed") || result.preReg !== null)) {
      result.petsAllowed = true;
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
      const wm = String(extracted.weightPerDog).match(/(\d+(?:\.\d+)?)\s*(lbs?|pounds?|pds?|kgs?|kilos?)/i);
      if (wm) {
        const val = parseFloat(wm[1]);
        const isKg = /kg|kilo/i.test(wm[2]);
        const unit = isKg ? "kg" : "lb";
        const pounds = isKg ? val * 2.20462262 : val;
        weightLimit = { value: val, unit, pounds };
      }
    }

    // 2. Fee normalization
    // fee: { amount: number | null, text?: string, currency: string, period: "night" | "day" | "stay" | "pet" | "unknown", perPet?: boolean, tiered?: boolean }
    let fee = null;
    if (extracted.fee && extracted.fee !== "No fee mentioned") {
      const str = String(extracted.fee);
      const isTiered = /\$0\s+(?:1st|first)\s+(?:dog|pet)/i.test(str);
      if (isTiered) {
        const tm = str.match(/,\s*(?:([A-Z]{1,3}\$|[$€£¥A-Z]{1,3}))?\s*(\d+(?:\.\d+)?)\s*(?:each)?\s*(?:subsequent|additional|extra|add'l)?\s*(?:dog|pet)?\s*(?:per\s+(stay|night|day))?/i);
        const curSym = (tm && tm[1]) || "$";
        const currency = normalizeCurrencyCode(curSym);
        const amount = tm && tm[2] ? parseFloat(tm[2]) : 0;
        const period = (tm && tm[3]) ? tm[3].toLowerCase() : "stay";
        fee = {
          amount,
          currency,
          period,
          perPet: true,
          text: str,
          tiered: true,
        };
      } else {
        const isPerPet = /\b(?:per\s+(?:pet|dog)|each\s+(?:pet|dog)?)\b/i.test(str);
        const fm = str.match(/(?:([A-Z]{1,3}\$|[$€£¥A-Z]{1,3}))?\s*(\d+(?:\.\d+)?)\s*(?:per\s+(?:pet|dog|each)\s+per\s+(stay|night|day)|per\s+(stay|night|day|pet))?/i);
        if (fm && fm[2]) {
          const curSym = fm[1] || "$";
          const currency = normalizeCurrencyCode(curSym);
          const amount = parseFloat(fm[2]);
          let period = "unknown";
          const matchedPeriod = fm[3] || fm[4];
          if (matchedPeriod) {
            period = matchedPeriod.toLowerCase();
          } else if (/\b(?:whole\s+trip|entire\s+stay|per\s+stay|flat)\b/i.test(str)) {
            period = "stay";
          } else if (isPerPet) {
            period = "pet";
          }
          fee = { amount, currency, period };
          if (isPerPet) {
            fee.perPet = true;
          }
        } else {
          fee = { amount: null, text: extracted.fee, currency: "USD", period: "unknown" };
        }
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
      } else {
        deposit = { amount: null, text: extracted.deposit, currency: "USD" };
      }
    }

    // 4. Restrictions found boolean
    const restrictionsFound = Boolean(
      extracted.preReg ||
      extracted.deposit ||
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
    const otherNotesCount = Array.isArray(extracted.otherNotes) ? extracted.otherNotes.length : 0;
    if (extracted.petsAllowed !== null) {
      confidence = (weightLimit || fee || extracted.maxDogs) ? "high" : "medium";
    } else if (extracted.preReg || otherNotesCount > 0) {
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
      restrictionNoteCount: otherNotesCount,
      contradictions,
      confidence,
      _raw: extracted,
    };
  }

  function formatFeeShort(fee) {
    if (!fee) return null;
    if (fee.tiered || (fee.text && /\$0\s+(?:1st|first)\s+(?:dog|pet)/i.test(fee.text))) {
      const amountStr = formatCurrencyDisplay(fee.amount, fee.currency);
      const periodSuffix = fee.period && fee.period !== "unknown" ? `/${fee.period}` : "";
      return `1st free · ${amountStr}/add'l${periodSuffix}`;
    }
    if (fee.amount === 0) return "No pet fee";
    if (fee.amount === null && fee.text) return fee.text;
    if (typeof fee.amount !== "number") return null;
    const amountStr = formatCurrencyDisplay(fee.amount, fee.currency);
    if (fee.perPet && fee.period && fee.period !== "unknown" && fee.period !== "pet") {
      return `${amountStr}/pet/${fee.period}`;
    }
    if (fee.period && fee.period !== "unknown") {
      return `${amountStr}/${fee.period}`;
    }
    return `${amountStr} pet fee`;
  }

  function formatDepositShort(deposit) {
    if (!deposit || deposit.amount === null) return null;
    return `${formatCurrencyDisplay(deposit.amount, deposit.currency)} deposit`;
  }

  function formatWeightShort(weightLimit) {
    if (!weightLimit || weightLimit.value === null) return null;
    const unitStr = weightLimit.unit === "lb" ? "lbs" : weightLimit.unit;
    return `${weightLimit.value} ${unitStr}`;
  }

  function collectPolicyBadgeDetails(policy, includeMaxDogs = true) {
    const details = [];

    // Primary constraints in priority order: maxDogs -> weight -> fee -> approval
    if (includeMaxDogs && policy.maxDogs) {
      details.push(`Max ${policy.maxDogs}`);
    }

    const weightStr = formatWeightShort(policy.weightLimit);
    if (weightStr) {
      details.push(weightStr);
    }

    const feeStr = formatFeeShort(policy.fee);
    if (feeStr) {
      details.push(feeStr);
    }

    if (policy.approvalRequired) {
      details.push("Approval required");
    }

    return details;
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
      const isTieredFee = policy.fee?.tiered || (policy.fee?.text && /\$0\s+(?:1st|first)/i.test(policy.fee.text));
      // If maxDogs prefix is used or fee is tiered (which is multi-part), limit secondary details to 2 items to stay within compact budget (< 60 chars)
      const maxSecondary = (policy.maxDogs || isTieredFee) ? 2 : 3;
      const details = collectPolicyBadgeDetails(policy, false).slice(0, maxSecondary);
      const detailStr = details.length ? ` · ${details.join(" · ")}` : "";
      const prefix = policy.maxDogs
        ? `Max ${policy.maxDogs} ${policy.maxDogs === 1 ? "dog" : "dogs"} allowed`
        : "Dogs allowed";
      return {
        statusKey: "allowed",
        icon: "🐾",
        text: `${prefix}${detailStr}`,
        className: "vdp-search-badge vdp-badge-allowed",
      };
    }

    if (policy.approvalRequired || policy.restrictionsFound || policy.weightLimit || policy.fee || policy.maxDogs || policy.restrictionNoteCount > 0) {
      const details = collectPolicyBadgeDetails(policy, true).slice(0, 3);
      const detailStr = details.length ? ` · ${details.join(" · ")}` : "";
      return {
        statusKey: "restrictions",
        icon: "🐾",
        text: `Pet restrictions${detailStr}`,
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

  /**
   * Universal Vrbo property ID extractor from URL strings or pathnames.
   */
  function extractPropertyId(urlOrPath, baseUrl = "https://www.vrbo.com") {
    if (!urlOrPath || typeof urlOrPath !== "string") return null;
    let path = urlOrPath;
    try {
      const u = new URL(urlOrPath, baseUrl);
      path = u.pathname;
    } catch {}
    const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(path);
    if (!m) return null;
    let id = m[1];
    if (/^p\d+/i.test(id)) id = id.slice(1);
    return id || null;
  }

  /**
   * Walk Apollo graph with full __ref pointer resolution and support for nested header.text and value/text leaves.
   */
  function walkApolloNode(state, node, headerCtx, sectionCtx, out, visited = new Set(), depth = 0, isExplicitPetContext = false) {
    if (node == null || depth > 35) return;

    if (node && typeof node === "object" && typeof node.__ref === "string") {
      if (visited.has(node.__ref)) return;
      visited.add(node.__ref);
      const target = state[node.__ref];
      if (target) walkApolloNode(state, target, headerCtx, sectionCtx, out, visited, depth + 1, isExplicitPetContext);
      return;
    }

    if (Array.isArray(node)) {
      for (const el of node) walkApolloNode(state, el, headerCtx, sectionCtx, out, visited, depth + 1, isExplicitPetContext);
      return;
    }

    if (typeof node !== "object") return;

    // Multi-Unit Hierarchy Pruning (Class 11):
    // Do not follow unit/room-level branches when inspecting top-level property
    if (node.__typename && /^(?:Unit|RentalUnit|Room|LodgingUnit|RatePlan|RoomType)$/i.test(node.__typename)) {
      return;
    }

    let nextHeader = headerCtx;
    let nextSection = sectionCtx;
    let explicitPet = isExplicitPetContext || Boolean(node.__typename && /^(?:PetPolicy|PropertyPets|PetsAmenity)$/i.test(node.__typename));

    if (node.__typename && /^(?:PetPolicy|PropertyPets|PetsAmenity)$/i.test(node.__typename)) {
      if (!nextHeader || nextHeader === "Listing Data") nextHeader = "Pets";
      if (!nextSection || nextSection === "Rules") nextSection = "House Rules / Policies";
    }

    const headerText = typeof node.header === "object" ? node.header?.text : (typeof node.header === "string" ? node.header : "");
    if (typeof headerText === "string" && headerText.trim()) {
      nextHeader = headerText.trim();
      if (/house rules|polic|important information/i.test(nextHeader)) nextSection = "House Rules / Policies";
      else if (/about this property|about this space|about this listing/i.test(nextHeader)) nextSection = "About this property";
      else if (!nextSection) nextSection = nextHeader;
      if (/^pets?$/i.test(nextHeader)) explicitPet = true;
    }
    if (typeof node.sectionName === "string" && node.sectionName.trim()) {
      nextHeader = node.sectionName.trim();
      if (/house rules|polic/i.test(nextHeader)) nextSection = "House Rules / Policies";
      if (/^pets?$/i.test(nextHeader)) explicitPet = true;
    }

    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      const v = node[k];
      if ((k === "value" || k === "text" || k === "body" || k === "description") && typeof v === "string" && v.trim().length > 0) {
        out.push({
          header: nextHeader || "Listing Data",
          section: nextSection || nextHeader || "Rules",
          text: v.trim(),
          isDedicatedPetsHeader: explicitPet,
          explicitPetContext: explicitPet,
        });
      } else if (v && typeof v === "object") {
        walkApolloNode(state, v, nextHeader, nextSection, out, visited, depth + 1, explicitPet);
      }
    }
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
    formatCurrencyDisplay,
    normalizeCurrencyCode,
    extractPropertyId,
    walkApolloNode,
  };
});
