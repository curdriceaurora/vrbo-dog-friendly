// Vrbo Dog Policy Callout — content script (isolated world)
//
// Two layers of data collection:
//  1. Page data (preferred): page-bridge.js runs in the page's own JS
//     world and reads window.__APOLLO_STATE__ — the GraphQL cache Vrbo
//     already populated on page load. This covers "About this property",
//     "House Rules"/Policies (including its "Pets" row), amenities, and
//     "Important information", REGARDLESS of whether those sections have
//     been scrolled into view or expanded, because Vrbo lazy-mounts a lot
//     of this into the DOM only on scroll/click even though the text was
//     already fetched.
//  2. Visible DOM text (fallback/supplement): in case Apollo data is
//     unavailable, incomplete, or Vrbo changes its internal schema, we
//     also expand any "show more" style toggles we can find and scan
//     the rendered page text.
//
// Because hosts sometimes give conflicting pet info in different spots
// (e.g. "50 lbs" in House Rules vs "75 lbs" in a freeform note), we keep
// every distinct match we find, surface the first/highest-confidence one
// as the headline value, and flag when there's disagreement so the user
// isn't quietly shown a cherry-picked number. Anything pet-related we
// can't slot into a structured field (breed limits, crate rules, leash
// rules, deposits, etc.) is kept and surfaced as free-text notes too.

(() => {
  const PANEL_ID = "vdp-panel";
  let lastScannedUrl = location.href;
  let rescanTimer = null;
  let latestApolloPayload = null;
  let isScanning = false;
  let mutationFirstSeenAt = 0;
  let suppressObserver = false;
  let observer = null;

  // ---------- text gathering: DOM (fallback layer) ----------

  function getSentences(text) {
    return text
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0 && s.length < 400);
  }

  function isPetRelated(s) {
    return /\b(pets?|dogs?|canine)\b/i.test(s);
  }

  function looksLikeListingPage() {
    if (document.querySelector('[data-stid*="pet"]')) return true;
    const bodyText = document.body ? document.body.innerText : "";
    return /house rules/i.test(bodyText) || /pet(s)? (allowed|policy|friendly)/i.test(bodyText);
  }

  // Click anything that looks like a "show more / read more / expand"
  // toggle inside likely-relevant sections, and briefly scroll any
  // still-empty lazyload placeholders into view so they mount, then
  // restore scroll position. Best-effort; safe to no-op if nothing found.
  // The MutationObserver is suppressed while this runs so our own DOM
  // pokes don't trigger a feedback loop of rescans.
  async function expandCollapsedSections() {
    suppressObserver = true;
    try {
      const TOGGLE_TEXT_RE = /^(show more|show all|see more|see all|view more|view all|read more|expand|more( details| rules| info)?)$/i;
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-expanded]')).filter((el) => {
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) return false;
        const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
        if (el.getAttribute("aria-expanded") === "false") return true;
        return TOGGLE_TEXT_RE.test(label);
      });

      for (const el of candidates.slice(0, 25)) {
        try {
          el.click();
        } catch (e) {
          /* ignore */
        }
      }
      if (candidates.length) {
        await new Promise((r) => setTimeout(r, 400));
      }

      // Nudge any empty lazyload placeholders (Vrbo mounts content on
      // intersection) into view momentarily, then restore scroll.
      const placeholders = Array.from(document.querySelectorAll(".lazyload-wrapper, [id]"))
        .filter((el) => {
          if (el.id && !/polic|rule|amenit/i.test(el.id)) return false;
          return el.textContent.trim().length < 5;
        })
        .slice(0, 5);

      if (placeholders.length) {
        const prevX = window.scrollX;
        const prevY = window.scrollY;
        for (const el of placeholders) {
          el.scrollIntoView({ block: "center" });
          await new Promise((r) => setTimeout(r, 350));
        }
        window.scrollTo(prevX, prevY);
      }
    } finally {
      suppressObserver = false;
    }
  }

  function collectDomPetSentences() {
    const bodyText = document.body ? document.body.innerText : "";
    return getSentences(bodyText).filter(isPetRelated);
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

  function buildCorpus(apolloPayload) {
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
        for (const sentence of getSentences(it.text)) {
          if (trustWholesale || isPetRelated(sentence)) {
            bucket.push({ text: sentence, source: it.section || it.header || "Listing data", priority });
          }
        }
      }
    }
    for (const sentence of collectDomPetSentences()) {
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

  // ---------- extraction ----------

  const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const NUM_RE = `(\\d+|${Object.keys(WORD_NUMS).join("|")})`;

  function toNumber(numStr) {
    const lower = numStr.toLowerCase();
    if (WORD_NUMS[lower] !== undefined) return WORD_NUMS[lower];
    return parseInt(numStr, 10);
  }

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
    const NOT_ALLOWED_RE = /\bno\s+pets?\b(?!\s*(?:over|above|larger|bigger|heavier|weighing|without|unless|except))|\bpets?\s+(?:are\s+)?not\s+(?:allowed|permitted)\b(?!\s*(?:over|above|without|unless|except))|\bpet[-\s]?free\b/i;
    const ALLOWED_RE = /\bpets?\s+(?:are\s+)?(?:allowed|permitted|welcome)\b|\bdog[-\s]?friendly\b|\bpet[-\s]?friendly\b/i;

    const MAX_DOGS_RE = [
      new RegExp(`\\b(?:up to|maximum of|max\\.?|no more than|limit(?:ed)? to|limit of)\\s*${NUM_RE}\\s*(?:dogs?|pets?)\\b`, "i"),
      new RegExp(`\\b${NUM_RE}\\s*(?:dogs?|pets?)\\s*(?:max(?:imum)?|allowed|permitted|total)\\b`, "i"),
      new RegExp(`\\blimit\\s*${NUM_RE}\\s*(?:dogs?|pets?)(?:\\s*total)?\\b`, "i"),
    ];

    const WEIGHT_RE = [
      /\b(\d{1,3})\s*(?:lbs?\.?|pounds?)\s*(?:per (?:dog|pet)|each|max(?:imum)?|or (?:less|under)|weight limit)\b/i,
      /\bweight limit\s*(?:of|is|:)?\s*(\d{1,3})\s*(?:lbs?\.?|pounds?)\b/i,
      /\b(?:up to|under|less than|max(?:imum)?(?:\s+of)?)\s*(\d{1,3})\s*(?:lbs?\.?|pounds?)\b/i,
      /\bcombined weight of\s*(\d{1,3})\s*(?:lbs?\.?|pounds?)\b/i,
    ];

    const PREREG_RE = /\b(pre-?register|register(?:ed|ation)?\s+(?:your|the)?\s*pets?|must\s+be\s+registered|registration\s+(?:is\s+)?required|notify\s+(?:the\s+)?(?:host|owner|property|management)|please\s+notify|let\s+us\s+know|inform\s+(?:the\s+)?(?:host|owner|property)|advance\s+notice|prior\s+(?:approval|permission|notice)|contact\s+(?:the\s+)?(?:host|owner|property)\s+(?:before|prior to)|must\s+be\s+approved|approval\s+(?:is\s+)?required)\b/i;

    const FEE_RE = [
      /\$\s?(\d{1,4}(?:\.\d{2})?)\s*(?:one[-\s]?time|non[-\s]?refundable)?\s*(?:\+\s*tax\s*)?(?:pet|dog)\s*fee/i,
      /(?:pet|dog)\s*fee\s*(?:of|is|:)?\s*\$\s?(\d{1,4}(?:\.\d{2})?)/i,
      /\$\s?(\d{1,4}(?:\.\d{2})?)\s*per\s*(?:pet|dog)(?:\s*per\s*(night|stay|day))?/i,
    ];
    const NO_FEE_RE = /\bno\s+(?:additional\s+)?(?:pet|dog)\s*fee\b|\bpets?\s+(?:stay\s+)?free\b/i;
    const DEPOSIT_RE = /\$\s?(\d{1,4}(?:\.\d{2})?)\s*(?:refundable\s*)?(?:pet|dog)\s*deposit|(?:pet|dog)\s*deposit\s*(?:of|is|:)?\s*\$\s?(\d{1,4}(?:\.\d{2})?)/i;

    function record(field, snippetField, sourceField, altField, value, entry) {
      if (result[field] === null) {
        result[field] = value;
        result[snippetField] = entry.text;
        result[sourceField] = entry.source;
      } else if (result[field] !== value && !result[altField].some((a) => a.value === value)) {
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

      for (const re of MAX_DOGS_RE) {
        const m = s.match(re);
        if (m) {
          record("maxDogs", "maxDogsSnippet", "maxDogsSource", "maxDogsAlternates", toNumber(m[1]), entry);
          usedForField = true;
          break;
        }
      }

      for (const re of WEIGHT_RE) {
        const m = s.match(re);
        if (m) {
          record("weightPerDog", "weightSnippet", "weightSource", "weightAlternates", `${m[1]} lbs`, entry);
          usedForField = true;
          break;
        }
      }

      if (PREREG_RE.test(s)) {
        if (result.preReg === null) {
          result.preReg = true;
          result.preRegSnippet = s;
          result.preRegSource = entry.source;
        }
        usedForField = true;
      }

      for (const re of FEE_RE) {
        const m = s.match(re);
        if (m) {
          const suffix = m[2] ? ` per ${m[2]}` : "";
          record("fee", "feeSnippet", "feeSource", "feeAlternates", `$${m[1]}${suffix}`, entry);
          usedForField = true;
          break;
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

      const depMatch = s.match(DEPOSIT_RE);
      if (depMatch && result.deposit === null) {
        result.deposit = `$${depMatch[1] || depMatch[2]}`;
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
    result.otherNotes = result.otherNotes.filter((n) => {
      const key = n.text.toLowerCase();
      if (seenNotes.has(key)) return false;
      seenNotes.add(key);
      return true;
    }).slice(0, 6);

    return result;
  }

  // ---------- DOM helpers (jump-to-source) ----------

  function findNodeForSnippet(snippet) {
    if (!snippet) return null;
    const short = snippet.slice(0, 40);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(short)) {
        return node.parentElement;
      }
    }
    return null;
  }

  function findHeadingFor(sourceLabel) {
    const re = /about this property/i.test(sourceLabel || "") ? /about this property/i : /house rules|polic/i;
    const candidates = document.querySelectorAll('h1,h2,h3,h4,[role="heading"],a[href^="#"]');
    for (const el of candidates) {
      if (re.test(el.textContent || "")) return el;
    }
    return null;
  }

  function jumpToSnippet(snippet, source) {
    let el = findNodeForSnippet(snippet);
    if (!el) el = findHeadingFor(source);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("vdp-highlight");
      setTimeout(() => el.classList.remove("vdp-highlight"), 2200);
    }
  }

  // ---------- rendering ----------

  function removePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function row(label, valueHtml, tone, snippet, source, alternates) {
    const toneClass = tone ? `vdp-tone-${tone}` : "";
    const jumpAttr = snippet ? `data-snippet="${encodeURIComponent(snippet)}" data-source="${encodeURIComponent(source || "")}"` : "";
    const jumpBtn = snippet ? `<button class="vdp-jump" ${jumpAttr} title="Show where this was found">source</button>` : "";
    const altHtml =
      alternates && alternates.length
        ? `<div class="vdp-alt">⚠ Listing also states elsewhere: ${alternates
            .map((a) => `<strong>${escapeHtml(a.value)}</strong> (${escapeHtml(a.source || "")})`)
            .join("; ")}</div>`
        : "";
    return `<div class="vdp-row-wrap">
      <div class="vdp-row">
        <span class="vdp-label">${label}</span>
        <span class="vdp-value ${toneClass}">${valueHtml}</span>
        ${jumpBtn}
      </div>
      ${altHtml}
    </div>`;
  }

  function renderPanel(policy) {
    removePanel();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    let rowsHtml = "";
    let headline = "";
    let headlineTone = "neutral";

    if (policy.petsAllowed === false) {
      headline = "🚫 Pets are not allowed";
      headlineTone = "bad";
      rowsHtml = row("Policy", "No pets allowed", "bad", policy.petsAllowedSnippet, policy.petsAllowedSource);
    } else if (!policy.found) {
      headline = "🐾 No dog policy details detected";
      headlineTone = "unknown";
      rowsHtml = `<div class="vdp-empty">This page didn't mention pets/dogs in its listing data or visible text. Try Rescan after the page fully loads, or check House Rules manually.</div>`;
    } else {
      headline = policy.petsAllowed === true ? "🐾 Dog-friendly" : "🐾 Dog policy found";
      headlineTone = policy.petsAllowed === true ? "good" : "unknown";

      rowsHtml += row(
        "Max dogs",
        policy.maxDogs !== null ? `${policy.maxDogs}` : "Not specified",
        policy.maxDogs !== null ? "good" : "unknown",
        policy.maxDogsSnippet,
        policy.maxDogsSource,
        policy.maxDogsAlternates
      );
      rowsHtml += row(
        "Weight limit",
        policy.weightPerDog || "Not specified",
        policy.weightPerDog ? "good" : "unknown",
        policy.weightSnippet,
        policy.weightSource,
        policy.weightAlternates
      );
      rowsHtml += row(
        "Pre-registration",
        policy.preReg ? "Required" : "Not mentioned",
        policy.preReg ? "warn" : "unknown",
        policy.preRegSnippet,
        policy.preRegSource
      );
      rowsHtml += row(
        "Fee",
        policy.fee || "Not specified",
        policy.fee && policy.fee !== "No fee mentioned" ? "warn" : policy.fee === "No fee mentioned" ? "good" : "unknown",
        policy.feeSnippet,
        policy.feeSource,
        policy.feeAlternates
      );
      if (policy.deposit) {
        rowsHtml += row("Refundable deposit", policy.deposit, "warn", policy.depositSnippet, policy.depositSource);
      }

      if (policy.otherNotes.length) {
        rowsHtml += `<div class="vdp-other-toggle">Other pet notes (${policy.otherNotes.length}) ▾</div>
          <div class="vdp-other-list">
            ${policy.otherNotes
              .map((n) => `<div class="vdp-other-item">"${escapeHtml(n.text)}" <span class="vdp-other-source">— ${escapeHtml(n.source)}</span></div>`)
              .join("")}
          </div>`;
      }
    }

    const usedApollo = policy.entries && policy.entries.some((e) => e.priority > 1);
    const sourceBadge = policy.found
      ? usedApollo
        ? "Source: listing data (incl. collapsed/lazy sections)"
        : "Source: visible page text only"
      : "";

    panel.innerHTML = `
      <div class="vdp-header vdp-tone-${headlineTone}">
        <span class="vdp-title">${headline}</span>
        <div class="vdp-header-btns">
          <button class="vdp-rescan" title="Rescan page">↻</button>
          <button class="vdp-close" title="Close">×</button>
        </div>
      </div>
      <div class="vdp-body">
        ${rowsHtml}
        ${sourceBadge ? `<div class="vdp-source-badge">${sourceBadge}</div>` : ""}
      </div>
    `;

    document.documentElement.appendChild(panel);

    panel.querySelector(".vdp-close").addEventListener("click", () => panel.remove());
    panel.querySelector(".vdp-rescan").addEventListener("click", () => scan(true));
    panel.querySelectorAll(".vdp-jump").forEach((btn) => {
      btn.addEventListener("click", () => {
        const snippet = decodeURIComponent(btn.getAttribute("data-snippet"));
        const source = decodeURIComponent(btn.getAttribute("data-source") || "");
        jumpToSnippet(snippet, source);
      });
    });
    const otherToggle = panel.querySelector(".vdp-other-toggle");
    if (otherToggle) {
      otherToggle.addEventListener("click", () => {
        panel.querySelector(".vdp-other-list").classList.toggle("vdp-visible");
      });
    }

    const header = panel.querySelector(".vdp-header");
    header.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      panel.classList.toggle("vdp-collapsed");
    });
  }

  // ---------- scan orchestration ----------

  async function scan(force) {
    if (isScanning) return;
    if (!force && !looksLikeListingPage()) {
      removePanel();
      return;
    }
    isScanning = true;
    try {
      await expandCollapsedSections();
      const entries = buildCorpus(latestApolloPayload);
      const policy = extractPolicy(entries);
      window.__vdpLastPolicy = policy;
      chrome.storage?.local?.set?.({ vdpLastPolicy: policy, vdpLastUrl: location.href });
      renderPanel(policy);
    } finally {
      isScanning = false;
    }
  }

  function scheduleRescan(delay) {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scan(false), delay);
  }

  function onUrlMaybeChanged() {
    if (location.href !== lastScannedUrl) {
      lastScannedUrl = location.href;
      removePanel();
      latestApolloPayload = null;
      window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));
      scheduleRescan(1200);
      setTimeout(() => scan(false), 3200);
    }
  }

  // Bridge data listener (page-bridge.js runs in the MAIN world).
  window.addEventListener("vdp-apollo-data", (e) => {
    latestApolloPayload = e.detail;
    scheduleRescan(150);
  });
  // Ask the bridge for whatever it already has, in case it fired before
  // we attached this listener.
  window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));

  // SPA navigation detection, several independent layers since no single
  // one is bulletproof on every SPA:
  //  1. Patch history.pushState/replaceState. Works for the vast majority
  //     of React-router-style navigations, since `history` is a live
  //     browsing-context object shared with the page, not a JS-realm-local
  //     copy — but if the page captured a reference to the original
  //     function before this script ran, our patch wouldn't see that call.
  //  2. popstate (back/forward navigation).
  //  3. A cheap interval poll of location.href as a permission-free
  //     backstop that catches anything the other two miss.
  //  4. The MutationObserver below also indirectly catches navigation,
  //     since the DOM changes regardless of how the URL changed.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const ret = original.apply(this, args);
      window.dispatchEvent(new Event("vdp-locationchange"));
      return ret;
    };
  }
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("vdp-locationchange")));
  window.addEventListener("vdp-locationchange", onUrlMaybeChanged);
  setInterval(onUrlMaybeChanged, 1000);

  // MutationObserver, scoped to the narrowest reasonable root and debounced
  // with a hard cap so continuously-animating widgets (carousels, maps)
  // can't starve us of a rescan forever. Suppressed while we're clicking
  // things ourselves in expandCollapsedSections to avoid feedback loops.
  function startObserver() {
    const root = document.querySelector("main") || document.body || document.documentElement;
    observer = new MutationObserver(() => {
      if (suppressObserver) return;
      const now = Date.now();
      if (!mutationFirstSeenAt) mutationFirstSeenAt = now;
      const elapsed = now - mutationFirstSeenAt;
      if (elapsed > 4000) {
        // Hard cap: force a scan even if mutations are still flowing.
        mutationFirstSeenAt = 0;
        scheduleRescan(0);
      } else {
        scheduleRescan(900);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }
  startObserver();

  // initial run
  scheduleRescan(1000);
  setTimeout(() => scan(false), 3500);

  // respond to popup requests
  chrome.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (msg?.type === "vdp-get-policy") {
      sendResponse({ policy: window.__vdpLastPolicy || null, url: location.href });
    } else if (msg?.type === "vdp-rescan") {
      scan(true).then(() => sendResponse({ policy: window.__vdpLastPolicy || null }));
      return true;
    }
    return true;
  });
})();
