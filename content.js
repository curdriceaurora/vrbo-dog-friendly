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
  let pendingRescan = false;
  let observer = null;

  // ---------- text gathering: DOM (fallback layer) ----------

  // Parsing/extraction lives in extract.js (loaded ahead of this script in
  // the same isolated world) so it can be unit-tested without a browser.
  const { getSentences, isPetRelated, buildCorpus, extractPolicy } = globalThis.VDPExtract;

  function getListingIdFromUrl(urlStr) {
    if (globalThis.VdpSearchFetcher?.extractPropertyIdFromUrl) {
      return globalThis.VdpSearchFetcher.extractPropertyIdFromUrl(urlStr || location.href);
    }
    try {
      const u = new URL(urlStr || location.href);
      const m = /(?:\/pdp(?:\/lo)?\/|\/vacation-rentals?(?:\/p)?\/p?|\/)(p?\d+[a-z0-9]*)(?:\/|\?|$)/i.exec(u.pathname);
      if (!m) return null;
      let id = m[1];
      if (/^p\d+/i.test(id)) id = id.slice(1);
      return id;
    } catch {
      return null;
    }
  }

  function isListingUrl(urlStr) {
    try {
      const u = new URL(urlStr || location.href);
      if (!/^(www\.)?vrbo\.com$/i.test(u.hostname)) return false;
      const path = u.pathname;
      if (/^\/\d+[a-z0-9]*\/?$/i.test(path)) return true;
      if (/^\/pdp(\/lo)?\/\d+[a-z0-9]*\/?$/i.test(path)) return true;
      if (/^\/vacation-rentals?(\/p)?\/?p?\d+[a-z0-9]*\/?$/i.test(path)) return true;
      return false;
    } catch {
      return false;
    }
  }

  function isSearchUrl(urlStr) {
    try {
      const u = new URL(urlStr || location.href);
      if (!/^(www\.)?vrbo\.com$/i.test(u.hostname)) return false;
      return /(?:hotel-search|search|vacation-rentals\/search)/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function looksLikeListingPage() {
    return isListingUrl(location.href);
  }

  // Click anything that looks like a "show more / read more / expand"
  // toggle inside likely-relevant sections, and briefly scroll any
  // still-empty lazyload placeholders into view so they mount, then
  // restore scroll position. Best-effort; safe to no-op if nothing found.
  // The MutationObserver is suppressed while this runs so our own DOM
  // pokes don't trigger a feedback loop of rescans.
  // Text harvested from dialogs this pass opened, since closing them again
  // takes the content back out of the DOM.
  //
  // Tagged with the URL it came from, and ignored the moment that stops
  // matching. Harvested text is the one piece of listing content that
  // outlives the DOM it came from, so on an SPA hop to another listing it
  // would otherwise be presented as the new property's pet policy — and
  // because it also satisfies the "do we have pet data yet" gate, the new
  // listing's own dialog would never be opened. Someone could book on it.
  // The URL tag holds even if the navigation detector misses the change.
  let harvestedDialogText = [];
  let harvestedForUrl = null;

  function visibleDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) => d.getClientRects().length > 0);
  }

  // Dialogs this extension caused to open, remembered across passes.
  //
  // Without this, a dialog we opened but failed to handle in time gets
  // treated as pre-existing by the NEXT pass — grandfathered as the
  // user's own — so it is never harvested and never closed, and a second
  // click adds another one beside it. Our leftovers must stay ours.
  const ownedDialogs = new WeakSet();

  // Watched for the FULL budget, with no early exit. An earlier version
  // stopped once two polls were quiet, which is the same "it will have
  // mounted by now" guess as the original fixed 400ms wait — just with a
  // bigger number, and it missed a dialog mounting at 1.7s exactly as the
  // 400ms version missed one at 700ms. Any threshold is wrong for some
  // page, and the early exit was optimising a cost that is not paid on
  // normal listings anyway: this whole pass only runs when we have no pet
  // data, or when the user explicitly asked for a rescan.
  const DIALOG_WATCH_MS = 4000;
  const DIALOG_POLL_MS = 250;

  // Clicking a control and waiting a fixed 400ms assumed the dialog mounts
  // within it. Vrbo's did; a slower one (measured at 700ms) was missed
  // entirely. Watch for a while instead, handling each dialog as it
  // appears, for the whole budget — see DIALOG_WATCH_MS above for why
  // there is deliberately no early exit.
  async function harvestAndCloseDialogs(preexisting) {
    const deadline = Date.now() + DIALOG_WATCH_MS;
    const handledThisPass = new Set();

    while (Date.now() < deadline) {
      for (const dialog of visibleDialogs()) {
        const isOurs = ownedDialogs.has(dialog) || !preexisting.has(dialog);
        if (!isOurs) continue;
        if (!handledThisPass.has(dialog)) {
          handledThisPass.add(dialog);
          ownedDialogs.add(dialog);
          // Harvest every pass it is still open: collectDomPetSentences
          // skips [role="dialog"] subtrees, so this is the only way the
          // text reaches the corpus.
          const text = dialog.innerText || "";
          if (text.trim()) harvestedDialogText.push({ text, source: "Property amenities" });
        }
        // Retried on later polls if the close didn't take.
        closeDialog(dialog);
      }
      await new Promise((r) => setTimeout(r, DIALOG_POLL_MS));
    }
    return handledThisPass.size;
  }

  function closeDialog(dialog) {
    const closer = dialog.querySelector('[aria-label*="close" i], button[title*="close" i]');
    if (closer) {
      try {
        closer.click();
        if (!dialog.getClientRects().length) return true;
      } catch (e) {
        /* fall through to Escape */
      }
    }
    // Escape as a fallback, for a dialog whose close control we don't
    // recognise. It bubbles from the dialog up to document by design —
    // that is how it reaches the site's handler — but that same handler
    // is usually global and closes whatever dialog IT considers topmost,
    // which can be one the user opened themselves. There is no way to
    // reach the site's handler without that risk, so only take it when no
    // foreign dialog is open. Leaving ours up is the lesser harm; closing
    // the user's is us breaking their page.
    // No Escape of any kind while someone else's dialog is open.
    //
    // A previous version tried a non-bubbling Escape first, on the theory
    // that it could only reach a handler attached to our own dialog. That
    // is wrong: a non-bubbling event still travels the CAPTURE phase from
    // window down to the target, so a site listening with
    // addEventListener("keydown", h, true) receives it either way and
    // closes whatever dialog it considers topmost — the user's. There is
    // no dispatch that reaches the site's handler for our dialog alone, so
    // the only safe answer is not to dispatch at all. Ours stays on screen;
    // the policy is still harvested and reported.
    const foreignOpen = visibleDialogs().some((d) => d !== dialog && !ownedDialogs.has(d));
    if (foreignOpen) return false;

    for (const bubbles of [false, true]) {
      for (const type of ["keydown", "keyup"]) {
        dialog.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles, cancelable: true }));
      }
      if (!dialog.getClientRects().length) return true;
    }
    return false;
  }

  async function expandCollapsedSections() {
    suppressObserver = true;
    harvestedDialogText = [];
    harvestedForUrl = location.href;
    // Some of what we click opens a dialog rather than expanding in place —
    // Vrbo's "See all" is a plain button with no aria-haspopup to filter on,
    // and it puts a full-screen amenities dialog over the listing. Note
    // which dialogs were already open so we only touch our own.
    const dialogsBefore = new Set(visibleDialogs());
    try {
      const TOGGLE_TEXT_RE = /^(show more|show all|see more|see all|view more|view all|read more|expand|more( details| rules| info)?)$/i;
      // Sections whose collapsed content is plausibly pet-relevant.
      const SECTION_CTX_RE = /house rules|polic|amenit|about this (property|space|listing)|important information|\bpets?\b|\bdogs?\b/i;
      // aria-expanded="false" is used by plenty of chrome that has nothing
      // to do with the listing — account menus, date pickers, currency
      // switchers, filter drawers. Clicking those opened UI at random, so
      // a collapsed element now also has to sit in a relevant section and
      // outside the page's navigation/dialog furniture.
      const OFF_LIMITS = 'nav, header, footer, [role="navigation"], [role="dialog"], [role="menu"], [role="tablist"]';

      // Climb looking for a section heading, bounded by how much text the
      // ancestor holds rather than by a fixed depth. Depth alone is the
      // wrong axis in both directions: Vrbo nests buttons several wrapper
      // divs deep, so a shallow cap misses real toggles, while climbing
      // to a section/[id] container (or far enough to reach one) lands on
      // something big enough that "house rules" appears SOMEWHERE in it on
      // every listing — at which point this returns true for everything
      // and we're back to clicking the whole page.
      const MAX_SECTION_CHARS = 3000;

      function inRelevantSection(el) {
        let node = el.parentElement;
        for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
          const text = node.textContent || "";
          if (text.length > MAX_SECTION_CHARS) break;
          if (SECTION_CTX_RE.test(text)) return true;
        }
        return false;
      }

      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-expanded]')).filter((el) => {
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) return false;
        if (el.closest(OFF_LIMITS)) return false;
        const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
        if (TOGGLE_TEXT_RE.test(label)) return true;
        if (el.getAttribute("aria-expanded") === "false") return inRelevantSection(el);
        return false;
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

      // Take the text out of anything we opened, then put the page back the
      // way we found it. The dialog is worth reading — Vrbo's amenities
      // dialog carries ~1.4KB of exactly the content the fallback wants —
      // but leaving it up covers the listing the user was reading.
      await harvestAndCloseDialogs(dialogsBefore);

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

  // Vrbo's search widget sits INSIDE <main>, and its pet-filter checkbox
  // ("I am traveling with pets", "If checked, only properties that allow
  // pets will be shown") is pet-related by every keyword test — it was
  // landing in the panel's notes as though the host had written it about
  // this property. Scoping to <main> isn't enough; what separates it from
  // listing prose is that it lives in form controls, which listing prose
  // never does. So walk text nodes and skip those subtrees.
  const DOM_EXCLUDE = 'label, form, button, select, textarea, input, nav, header, footer, script, style, [role="dialog"], [role="navigation"], [role="menu"], #vdp-panel';

  function findSectionHeadingForElement(element) {
    if (!element) return "Listing details";

    if (element.closest('#reviews, [id*="reviews" i], [data-stid*="reviews" i], [data-stid*="ratings-and-reviews"], [class*="reviews-" i], [class*="reviews " i], [class$="reviews" i], [data-section-type*="review" i]')) {
      return "Guest reviews";
    }
    if (element.closest('[data-stid*="house-rules" i], [class*="house-rules" i], [id*="house-rules" i], [data-stid*="policies" i], [id*="policies" i]')) {
      return "House Rules / Policies";
    }
    if (element.closest('[data-stid*="about" i], [class*="about" i], [id*="about" i]')) {
      return "About this property";
    }
    if (element.closest('[data-stid*="amenit" i], [class*="amenit" i], [id*="amenit" i]')) {
      return "Property amenities";
    }
    if (element.closest('[data-stid*="host" i], [class*="host" i], [id*="host" i]')) {
      return "About the host";
    }
    if (element.closest('[data-stid*="faq" i], [class*="faq" i], [id*="faq" i], [data-stid*="qna" i]')) {
      return "Questions & answers";
    }

    let curr = element;
    for (let i = 0; i < 8 && curr && curr !== document.body; i++, curr = curr.parentElement) {
      const heading = curr.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], [class*="heading" i], [class*="title" i]');
      if (heading && heading !== element && !heading.contains(element)) {
        const text = heading.textContent?.trim();
        if (text && text.length > 2 && text.length < 50) {
          if (/review|rating/i.test(text)) return "Guest reviews";
          if (/house rules|polic/i.test(text)) return "House Rules / Policies";
          if (/about this property|about this space|description/i.test(text)) return "About this property";
          if (/amenit/i.test(text)) return "Property amenities";
          if (/host/i.test(text)) return "About the host";
          return text;
        }
      }
      const label = curr.getAttribute("aria-label") || curr.getAttribute("data-stid") || curr.id;
      if (label) {
        if (/review/i.test(label)) return "Guest reviews";
        if (/house-rules|policies/i.test(label)) return "House Rules / Policies";
        if (/about/i.test(label)) return "About this property";
        if (/amenit/i.test(label)) return "Property amenities";
        if (/host/i.test(label)) return "About the host";
      }
    }

    return "Listing details";
  }

  function collectDomPetSentences() {
    const root = document.querySelector("main") || document.body;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const rawText = node.textContent && node.textContent.trim();
      if (!rawText) continue;
      const parent = node.parentElement;
      if (parent && parent.closest(DOM_EXCLUDE)) continue;

      let section = null;
      for (const sentence of getSentences(rawText)) {
        if (isPetRelated(sentence)) {
          if (!section) {
            section = findSectionHeadingForElement(parent);
          }
          results.push({ text: sentence, source: section });
        }
      }
    }
    // Dialogs we opened and closed again are no longer walkable, so their
    // text comes from the harvest instead — but only while we are still on
    // the listing it was taken from.
    if (harvestedForUrl === location.href) {
      for (const item of harvestedDialogText) {
        const text = typeof item === "string" ? item : item?.text;
        const source = (typeof item === "object" && item?.source) ? item.source : "Property amenities";
        for (const sentence of getSentences(text)) {
          if (isPetRelated(sentence)) {
            results.push({ text: sentence, source });
          }
        }
      }
    }
    return results;
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
    if (!sourceLabel) return null;
    let re = /house rules|polic/i;
    if (/about this property|about this space|description/i.test(sourceLabel)) re = /about this property|about this space|description/i;
    else if (/review|rating|feedback/i.test(sourceLabel)) re = /reviews|ratings/i;
    else if (/amenit/i.test(sourceLabel)) re = /amenit/i;
    else if (/host/i.test(sourceLabel)) re = /about the host|host/i;
    const candidates = document.querySelectorAll('h1,h2,h3,h4,[role="heading"],a[href^="#"],section,[data-stid]');
    for (const el of candidates) {
      if (re.test(el.textContent || "") || re.test(el.getAttribute("data-stid") || "")) return el;
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

  // `value` is always escaped. Today every caller passes a literal or a
  // digits-only regex capture, so nothing can break out — but escaping
  // here means a future pattern that captures freeform listing text
  // can't turn into an injection point.
  function row(label, value, tone, snippet, source, alternates) {
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
        <span class="vdp-value ${toneClass}">${escapeHtml(value)}</span>
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
    const raw = policy._raw || policy;

    if (policy.petsAllowed === false) {
      headline = "🚫 Pets are not allowed";
      headlineTone = "bad";
      rowsHtml = row("Policy", "No pets allowed", "bad", raw.petsAllowedSnippet, raw.petsAllowedSource);
    } else if (!raw.found && !policy.restrictionsFound) {
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
        raw.maxDogsSnippet,
        raw.maxDogsSource,
        raw.maxDogsAlternates
      );
      rowsHtml += row(
        "Weight limit",
        policy.weightLimit ? `${policy.weightLimit.value} ${policy.weightLimit.unit === "lb" ? "lbs" : policy.weightLimit.unit}` : (raw.weightPerDog || "Not specified"),
        policy.weightLimit || raw.weightPerDog ? "good" : "unknown",
        raw.weightSnippet,
        raw.weightSource,
        raw.weightAlternates
      );
      rowsHtml += row(
        "Pre-registration",
        (policy.approvalRequired || raw.preReg) ? "Required" : "Not mentioned",
        (policy.approvalRequired || raw.preReg) ? "warn" : "unknown",
        raw.preRegSnippet,
        raw.preRegSource
      );
      let feePerStr = "";
      if (policy.fee) {
        if (policy.fee.perPet && policy.fee.period && policy.fee.period !== "unknown" && policy.fee.period !== "pet") {
          feePerStr = ` per pet per ${policy.fee.period}`;
        } else if (policy.fee.period && policy.fee.period !== "unknown") {
          feePerStr = ` per ${policy.fee.period}`;
        }
      }
      const isTieredFee = policy.fee?.tiered || (policy.fee?.text && /\$0\s+(?:1st|first)/i.test(policy.fee.text));
      let feeDisplay;
      if (isTieredFee) {
        feeDisplay = policy.fee.text || "1st dog free, subsequent fee applies";
      } else if (policy.fee && policy.fee.amount !== null) {
        feeDisplay = typeof VDPExtract?.formatCurrencyDisplay === "function"
          ? `${VDPExtract.formatCurrencyDisplay(policy.fee.amount, policy.fee.currency)}${feePerStr}`
          : `$${policy.fee.amount}${feePerStr}`;
      } else {
        feeDisplay = raw.fee || "Not specified";
      }

      rowsHtml += row(
        "Fee",
        feeDisplay,
        policy.fee && policy.fee.amount > 0 ? "warn" : policy.fee && policy.fee.amount === 0 ? "good" : (raw.fee && raw.fee !== "No fee mentioned" ? "warn" : "unknown"),
        raw.feeSnippet,
        raw.feeSource,
        raw.feeAlternates
      );
      if (policy.deposit || raw.deposit) {
        const depDisplay = policy.deposit && policy.deposit.amount !== null
          ? (typeof VDPExtract?.formatCurrencyDisplay === "function" ? VDPExtract.formatCurrencyDisplay(policy.deposit.amount, policy.deposit.currency) : `$${policy.deposit.amount}`)
          : raw.deposit;
        rowsHtml += row("Refundable deposit", depDisplay, "warn", raw.depositSnippet, raw.depositSource);
      }

      const notes = raw.otherNotes || [];
      if (notes.length) {
        rowsHtml += `<div class="vdp-other-toggle">Other pet notes (${notes.length}) ▾</div>
          <div class="vdp-other-list">
            ${notes
              .map((n) => `<div class="vdp-other-item">"${escapeHtml(n.text)}" <span class="vdp-other-source">— ${escapeHtml(n.source)}</span></div>`)
              .join("")}
          </div>`;
      }
    }

    const entries = raw.entries || policy.entries;
    const found = raw.found ?? policy.found ?? policy.restrictionsFound;
    const usedApollo = entries && entries.some((e) => e.priority > 1);

    const calloutSources = [
      raw.petsAllowedSource,
      raw.maxDogsSource,
      raw.weightSource,
      raw.preRegSource,
      raw.feeSource,
      raw.depositSource,
    ].filter(Boolean);

    const hasReviewCallout = calloutSources.some((s) => /review|rating/i.test(s));
    const hasNonReviewCallout = calloutSources.some((s) => !/review|rating/i.test(s));

    let sourceBadge = "";
    if (found) {
      if (hasReviewCallout && (usedApollo || hasNonReviewCallout)) {
        sourceBadge = usedApollo
          ? "Source: listing data + review"
          : "Source: visible page text + review";
      } else if (hasReviewCallout) {
        sourceBadge = "Source: review";
      } else if (usedApollo) {
        sourceBadge = "Source: listing data (incl. collapsed/lazy sections)";
      } else {
        sourceBadge = "Source: visible page text only";
      }
    }

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
    // Don't drop a scan request that lands while one is in flight. The
    // expand pass can hold the lock for a couple of seconds, and the
    // rescan onUrlMaybeChanged schedules at 1200ms falls inside exactly
    // that window — so a dropped request meant a listing could keep the
    // previous one's panel until some unrelated mutation happened to
    // trigger another scan.
    if (isScanning) {
      pendingRescan = true;
      return;
    }
    if (!isListingUrl(location.href) || (!force && !looksLikeListingPage())) {
      removePanel();
      return;
    }
    isScanning = true;
    // Everything below describes THIS listing. scan() awaits, and an SPA
    // hop during an await leaves the rest of this function computing an
    // answer for a page that is no longer on screen — so bail rather than
    // render it. onUrlMaybeChanged has already cleared state and queued a
    // fresh scan for the new listing.
    const startUrl = location.href;
    try {
      // Decide whether to poke the DOM by asking whether we actually have
      // pet information yet — not merely whether the Apollo payload was
      // non-empty. A payload can be well populated with unrelated text
      // while the pet policy sits behind a "See all" control, and keying
      // on item count alone reported "No dog policy details detected" on
      // exactly those listings. A forced rescan always expands, since the
      // user asking for one is asking us to look harder.
      let entries = buildCorpus(latestApolloPayload, collectDomPetSentences());
      if (!entries.length || force) {
        await expandCollapsedSections();
        if (location.href !== startUrl) return;
        entries = buildCorpus(latestApolloPayload, collectDomPetSentences());
      }
      if (location.href !== startUrl) return;
      const rawPolicy = extractPolicy(entries);
      const propId = getListingIdFromUrl(startUrl);
      const canonicalPolicy = typeof VDPExtract?.normalizePolicy === "function"
        ? VDPExtract.normalizePolicy(rawPolicy, propId, "listing-page")
        : rawPolicy;
      window.__vdpLastPolicy = canonicalPolicy;
      chrome.storage?.local?.set?.({ vdpLastPolicy: canonicalPolicy, vdpLastUrl: startUrl });
      renderPanel(canonicalPolicy);
    } finally {
      isScanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        scheduleRescan(300);
      }
    }
  }

  function scheduleRescan(delay) {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => scan(false), delay);
  }

  // ---------- Search Page Card Badging & Hover Tooltips ----------

  let searchQueue = null;
  let searchCardObserver = null;
  let searchTooltipEl = null;
  let activeTooltipTarget = null;
  let activeTooltipPropId = null;
  let tooltipLeaveTimer = null;

  // Every property id we have bound to a card, mapped to the card node that
  // owns it. This is the ledger I7's prune walks: a tracked id whose node has
  // left the DOM is stale work that must be dropped.
  const trackedSearchCards = new Map(); // propertyId -> card element

  // I9: mutation-driven scans run on a leading-edge throttle. The first scan of
  // a burst runs synchronously (card binding must not lag a re-render), the rest
  // of the burst collapses into one trailing scan.
  const SEARCH_SCAN_THROTTLE_MS = 250;
  let lastSearchScanAt = 0;
  let searchScanThrottleTimer = null;

  // Instrumentation for #23's gating condition. LOCAL ONLY: these are in-memory
  // counters, readable from the devtools console of this isolated world via
  // `__vdpSearchStats()`. PRIVACY.md commits to no remote transmission of
  // browsing activity or analytics, so they are never written to
  // chrome.storage, never attached to a request, and never reported anywhere.
  const MAX_DEPTH_SAMPLES = 200;
  let searchStats = createEmptySearchStats();

  function createEmptySearchStats() {
    return {
      scans: 0,
      dispatched: 0, // Counts post-dwell card enqueue requests passed to the queue engine
      prunedOffscreen: 0,
      prunedRecycled: 0,
      prunedStale: 0,
      lastQueueDepth: 0,
      maxQueueDepth: 0,
      depthSamples: [], // [{ t, depth, reason }], bounded ring
    };
  }

  function resetSearchStats() {
    searchStats = createEmptySearchStats();
  }

  function sampleQueueDepth(reason) {
    if (!searchQueue || typeof searchQueue.getQueueLength !== "function") return;
    const depth = searchQueue.getQueueLength();
    searchStats.lastQueueDepth = depth;
    if (depth > searchStats.maxQueueDepth) searchStats.maxQueueDepth = depth;
    searchStats.depthSamples.push({ t: Date.now(), depth, reason });
    if (searchStats.depthSamples.length > MAX_DEPTH_SAMPLES) searchStats.depthSamples.shift();
  }

  function getSearchStats() {
    return { ...searchStats, depthSamples: searchStats.depthSamples.slice() };
  }

  // Read-only devtools hook. Returns a copy; nothing here is persisted or sent.
  globalThis.__vdpSearchStats = getSearchStats;

  function anotherCardHasPropId(propId, exceptCard) {
    if (!propId) return false;
    let nodes;
    try {
      nodes = document.querySelectorAll(`[data-vdp-prop-id="${propId}"]`);
    } catch {
      return false;
    }
    for (const node of nodes) {
      if (node !== exceptCard) return true;
    }
    return false;
  }

  // 8.1.1 Search-page Apollo fast path: before any listing-page request,
  // ask the page-world bridge for the exact PropertyInfo:<id> records the
  // search page already fetched. The response is delivered synchronously
  // during the request dispatch, so no card rendering is ever delayed on
  // it — when there is no usable record the path falls through to the
  // queue immediately.
  const discoveredSearchPropIds = new Set();
  let latestSearchApolloData = null;
  let searchApolloRequestId = 0;

  function requestSearchApolloData() {
    if (!discoveredSearchPropIds.size) return null;
    const requestId = ++searchApolloRequestId;
    const propertyIds = Array.from(discoveredSearchPropIds).slice(0, 40);
    try {
      window.dispatchEvent(new CustomEvent("vdp-search-apollo-request", { detail: { propertyIds, requestId } }));
    } catch (e) {
      return null;
    }
    // The bridge's response event fires synchronously inside the dispatch
    // above; only trust a payload answering THIS request.
    const payload = latestSearchApolloData;
    return payload && payload.requestId === requestId ? payload : null;
  }

  function trySearchApolloFastPath(propId) {
    if (!propId) return null;
    const fetcher = globalThis.VdpSearchFetcher;
    if (!fetcher) return null;
    discoveredSearchPropIds.add(propId);
    const payload = requestSearchApolloData();
    const record = payload && payload.results ? payload.results[propId] : null;
    if (!record || !Array.isArray(record.items) || !record.items.length) return null;
    const policy = typeof fetcher.resolveSearchApolloRecord === "function"
      ? fetcher.resolveSearchApolloRecord(record, propId, "search-page-state")
      : null;
    if (!policy) return null;
    return { status: "ok", propertyId: propId, policy, ts: Date.now(), _source: "search-page-state" };
  }

  function enqueueSearch(propId, url, priority = "normal") {
    const activeQueue = searchQueue;
    if (!activeQueue) return;

    try {
      const fast = trySearchApolloFastPath(propId);
      if (fast && globalThis.VdpSearchFetcher?.hasConcretePolicy?.(fast.policy)) {
        const isRichOrDefinitive = fast.policy.petsAllowed === false ||
          fast.policy.maxDogs !== null ||
          fast.policy.weightLimit !== null ||
          fast.policy.fee !== null ||
          fast.policy.deposit !== null;

        if (isRichOrDefinitive) {
          activeQueue.setCached(propId, fast).finally(() => {
            if (searchQueue && searchQueue === activeQueue && document.querySelector(`[data-vdp-prop-id="${propId}"]`)) {
              activeQueue.enqueue(propId, url, priority);
              searchStats.dispatched++;
              sampleQueueDepth("dispatch");
            }
          });
          return;
        } else {
          // Preliminary instant render: paint preliminary badge immediately without blocking rich listing fetch
          const card = document.querySelector(`[data-vdp-prop-id="${propId}"]`);
          const badge = card?.querySelector(".vdp-search-badge");
          if (badge && badge.dataset.vdpStatus === "loading") {
            updateBadgeUi(badge, fast);
          }
        }
      }
    } catch (e) {
      // Fall through to the normal queue path on any unexpected failure.
    }
    if (searchQueue && searchQueue === activeQueue) {
      activeQueue.enqueue(propId, url, priority);
      searchStats.dispatched++;
      sampleQueueDepth("dispatch");
    }
  }

  function clearTooltipLeaveTimer() {
    if (tooltipLeaveTimer) {
      clearTimeout(tooltipLeaveTimer);
      tooltipLeaveTimer = null;
    }
  }

  let isDismissingDialog = false;

  function scheduleTooltipHide(delayMs = 200) {
    clearTooltipLeaveTimer();
    tooltipLeaveTimer = setTimeout(() => {
      hideTooltip();
    }, delayMs);
  }

  function getListingValidation(urlStr) {
    if (globalThis.VdpSearchFetcher?.validateListingUrl) {
      return globalThis.VdpSearchFetcher.validateListingUrl(urlStr, location.href);
    }
    try {
      const u = new URL(urlStr, location.href);
      if (u.protocol !== "https:") return null;
      if (!/^(www\.)?vrbo\.com$/i.test(u.hostname)) return null;
      const propId = getListingIdFromUrl(u.href);
      if (!propId) return null;
      if (
        !/^\/\d+[a-z0-9]*\/?$/i.test(u.pathname) &&
        !/^\/pdp(\/lo)?\/\d+[a-z0-9]*\/?$/i.test(u.pathname) &&
        !/^\/vacation-rentals?(\/p)?\/?p?\d+[a-z0-9]*\/?$/i.test(u.pathname)
      ) {
        return null;
      }
      return {
        propertyId: propId,
        navigationUrl: u.href,
        fetchUrl: `https://www.vrbo.com${u.pathname}`,
      };
    } catch {
      return null;
    }
  }

  function findCardListing(card) {
    const anchors = card.querySelectorAll("a[href]");
    for (const a of anchors) {
      const href = a.href || a.getAttribute("href");
      if (!href) continue;
      const validated = getListingValidation(href);
      if (validated) return validated;
    }
    return null;
  }

  function initSearchManager() {
    if (!globalThis.VdpSearchFetcher) return;
    if (!searchQueue) {
      searchQueue = globalThis.VdpSearchFetcher.createSearchFetchQueue();
    }
    if (!searchTooltipEl) {
      searchTooltipEl = document.createElement("div");
      searchTooltipEl.id = "vdp-search-tooltip";
      searchTooltipEl.className = "vdp-search-tooltip";
      searchTooltipEl.setAttribute("role", "dialog");
      searchTooltipEl.setAttribute("aria-label", "Dog policy");
      searchTooltipEl.setAttribute("aria-hidden", "true");
      searchTooltipEl.style.display = "none";

      searchTooltipEl.addEventListener("mouseenter", () => {
        clearTooltipLeaveTimer();
      });
      searchTooltipEl.addEventListener("mouseleave", (e) => {
        if (e.relatedTarget && activeTooltipTarget?.contains(e.relatedTarget)) return;
        scheduleTooltipHide(200);
      });

      // Focus trap and Escape key listener inside dialog
      searchTooltipEl.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          const toFocus = activeTooltipTarget;
          isDismissingDialog = true;
          hideTooltip();
          toFocus?.focus();
          setTimeout(() => { isDismissingDialog = false; }, 150);
        } else if (e.key === "Tab") {
          const focusables = Array.from(searchTooltipEl.querySelectorAll('button, a[href], [tabindex="0"]')).filter(
            (el) => !el.disabled
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && (document.activeElement === first || !searchTooltipEl.contains(document.activeElement))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (document.activeElement === last || !searchTooltipEl.contains(document.activeElement))) {
            e.preventDefault();
            first.focus();
          }
        }
      });

      (document.body || document.documentElement).appendChild(searchTooltipEl);
    }

    const VIEWPORT_DWELL_MS = 400;
    // I4b: one-sided jitter, same rationale as the pacing jitter in the queue —
    // it only ever adds to the dwell, so the 400 ms floor is never undercut,
    // while a screenful of cards that enter the viewport together stops firing
    // its timers in unison.
    const VIEWPORT_DWELL_JITTER_MS = 200;

    if (!searchCardObserver) {
      searchCardObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const card = entry.target;
          if (entry.isIntersecting) {
            // I3: in-view state is read by the recycle path, which must not
            // enqueue for a card the user cannot see.
            card._vdpInView = true;
            if (card._vdpDwellTimer) {
              clearTimeout(card._vdpDwellTimer);
              card._vdpDwellTimer = null;
            }
            // Dwell debounce: only enqueue after card remains in viewport for
            // VIEWPORT_DWELL_MS (plus this card's own jitter).
            const dwellMs = VIEWPORT_DWELL_MS + Math.random() * VIEWPORT_DWELL_JITTER_MS;
            card._vdpDwellTimer = setTimeout(() => {
              card._vdpDwellTimer = null;
              const propId = card.getAttribute("data-vdp-prop-id");
              const fetchUrl = card.getAttribute("data-vdp-fetch-url") || card.getAttribute("data-vdp-url");
              if (propId && fetchUrl && searchQueue && card.isConnected) {
                enqueueSearch(propId, fetchUrl, "normal");
              }
            }, dwellMs);
          } else {
            card._vdpInView = false;
            // Scrolled out of viewport before dwell threshold: cancel background request
            if (card._vdpDwellTimer) {
              clearTimeout(card._vdpDwellTimer);
              card._vdpDwellTimer = null;
            }
            // I8b: the timer is only half of it. Once the dwell has elapsed the
            // work lives in the queue, so a card that leaves the viewport must
            // also withdraw its queued item. remove() is a no-op for an id that
            // is already in flight, which is the correct boundary: that request
            // is on the wire and cancelling it buys nothing.
            const propId = card.getAttribute("data-vdp-prop-id");
            if (propId && searchQueue && typeof searchQueue.remove === "function") {
              if (searchQueue.remove(propId)) {
                searchStats.prunedOffscreen++;
                sampleQueueDepth("prune-offscreen");
              }
            }
          }
        }
      }, { rootMargin: "150px 0px" });
    }

    scanSearchCards();
  }

  function cleanupSearchManager() {
    hideTooltip();
    discoveredSearchPropIds.clear();
    trackedSearchCards.clear();
    if (searchScanThrottleTimer) {
      clearTimeout(searchScanThrottleTimer);
      searchScanThrottleTimer = null;
    }
    lastSearchScanAt = 0;
    // Counters are queue-scoped: they reset with the queue they describe.
    resetSearchStats();
    latestSearchApolloData = null;
    if (searchQueue) {
      searchQueue.dispose();
      searchQueue = null;
    }
    if (searchCardObserver) {
      searchCardObserver.disconnect();
      searchCardObserver = null;
    }
    const badges = document.querySelectorAll(".vdp-search-badge");
    for (const b of badges) b.remove();
    const cards = document.querySelectorAll("[data-vdp-prop-id]");
    for (const c of cards) {
      if (c._vdpDwellTimer) {
        clearTimeout(c._vdpDwellTimer);
        c._vdpDwellTimer = null;
      }
      if (c._vdpUnsub) {
        c._vdpUnsub();
        c._vdpUnsub = null;
      }
      c._vdpInView = false;
      c.removeAttribute("data-vdp-prop-id");
      c.removeAttribute("data-vdp-url");
      c.removeAttribute("data-vdp-fetch-url");
      c.removeAttribute("data-vdp-nav-url");
    }
    if (searchTooltipEl) {
      searchTooltipEl.remove();
      searchTooltipEl = null;
    }
  }

  // I9: leading-edge throttle in front of scanSearchCards(). Vrbo's search
  // results mutate in long bursts (image swaps, price re-renders); before this,
  // every qualifying mutation ran a full re-scan.
  function requestSearchScan() {
    const now = Date.now();
    const sinceLast = now - lastSearchScanAt;
    if (sinceLast >= SEARCH_SCAN_THROTTLE_MS) {
      lastSearchScanAt = now;
      scanSearchCards();
      return;
    }
    if (searchScanThrottleTimer) return; // burst already has a trailing scan booked
    searchScanThrottleTimer = setTimeout(() => {
      searchScanThrottleTimer = null;
      lastSearchScanAt = Date.now();
      scanSearchCards();
    }, SEARCH_SCAN_THROTTLE_MS - sinceLast);
  }

  /**
   * I7: drop per-card state for property ids whose card has left the DOM, which
   * is what a search -> search re-render leaves behind.
   *
   * Deliberately NOT clearQueue(): that resets sessionRequestsCount to 0, and
   * the session budget has to survive search -> search — otherwise a user who
   * re-searches repeatedly gets an unbounded request allowance.
   *
   * Tearing down the subscription is not optional either. remove() only drops
   * *queued* work; a request already in flight for a pruned id still resolves
   * and calls notify(), which would repaint a card that has already moved on.
   */
  function pruneStaleSearchCards() {
    if (!searchQueue) return 0;
    let pruned = 0;
    for (const [propId, card] of Array.from(trackedSearchCards.entries())) {
      const boundId = card && typeof card.getAttribute === "function"
        ? card.getAttribute("data-vdp-prop-id")
        : null;
      if (card && card.isConnected && boundId === propId) continue;

      // Only tear down the card's subscription when the card is still bound to
      // THIS id. If the node was recycled to a different property, _vdpUnsub
      // belongs to the new binding and the old one was already released.
      if (card && boundId === propId) {
        if (card._vdpUnsub) {
          try { card._vdpUnsub(); } catch {}
          card._vdpUnsub = null;
        }
        if (card._vdpDwellTimer) {
          clearTimeout(card._vdpDwellTimer);
          card._vdpDwellTimer = null;
        }
        card._vdpInView = false;
        if (searchCardObserver) {
          try { searchCardObserver.unobserve(card); } catch {}
        }
      }
      if (!anotherCardHasPropId(propId, card)) {
        searchQueue.remove(propId);
        discoveredSearchPropIds.delete(propId);
      }
      trackedSearchCards.delete(propId);
      pruned++;
    }
    if (pruned) {
      searchStats.prunedStale += pruned;
      sampleQueueDepth("prune-stale");
    }
    return pruned;
  }

  function scanSearchCards() {
    if (!isSearchUrl(location.href)) return;
    searchStats.scans++;
    const cardSelectors = [
      '[data-stid="property-card"]',
      '[data-stid="lodging-card-responsive"]',
      '[data-testid="property-card"]',
      'article[data-stid*="card"]',
      'div[data-stid*="property-card"]',
    ];

    const cards = document.querySelectorAll(cardSelectors.join(", "));
    for (const card of cards) {
      bindSearchCard(card);
    }
    // Cards the re-render dropped are stale the moment they leave the DOM.
    pruneStaleSearchCards();
  }

  function bindSearchCard(card) {
    const listing = findCardListing(card);
    if (!listing) return;
    const { propertyId: propId, fetchUrl, navigationUrl } = listing;

    const prevId = card.getAttribute("data-vdp-prop-id");
    let badge = card.querySelector(".vdp-search-badge");

    // Same property, same badge, subscription intact: nothing to rewire.
    // A missing _vdpUnsub means a prune tore this card down while it was out of
    // the DOM, so fall through and re-subscribe — the propId is unchanged, so
    // the fall-through re-binds without issuing a new request.
    if (prevId === propId && badge && card._vdpUnsub) {
      card.setAttribute("data-vdp-fetch-url", fetchUrl);
      card.setAttribute("data-vdp-nav-url", navigationUrl);
      card.setAttribute("data-vdp-url", fetchUrl);
      trackedSearchCards.set(propId, card);
      return;
    }

    // Clean up previous subscription and dwell timer if card was recycled
    if (card._vdpDwellTimer) {
      clearTimeout(card._vdpDwellTimer);
      card._vdpDwellTimer = null;
    }
    if (card._vdpUnsub) {
      card._vdpUnsub();
      card._vdpUnsub = null;
    }

    // The property this node used to show is stale work now: withdraw its
    // queued item too, unless some other live card still displays it.
    if (prevId && prevId !== propId) {
      if (trackedSearchCards.get(prevId) === card) trackedSearchCards.delete(prevId);
      if (searchQueue && typeof searchQueue.remove === "function" && !anotherCardHasPropId(prevId, card)) {
        if (searchQueue.remove(prevId)) {
          searchStats.prunedRecycled++;
          sampleQueueDepth("prune-recycled");
        }
      }
    }

    card.setAttribute("data-vdp-prop-id", propId);
    card.setAttribute("data-vdp-fetch-url", fetchUrl);
    card.setAttribute("data-vdp-nav-url", navigationUrl);
    card.setAttribute("data-vdp-url", fetchUrl);
    discoveredSearchPropIds.add(propId);
    trackedSearchCards.set(propId, card);

    // Watch visibility for prefetching
    if (searchCardObserver) {
      try { searchCardObserver.unobserve(card); } catch {}
      searchCardObserver.observe(card);
    }

    if (!badge) {
      badge = document.createElement("div");
      badge.className = "vdp-search-badge vdp-badge-loading";
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("role", "button");
      badge.setAttribute("aria-haspopup", "dialog");
      badge.setAttribute("aria-controls", "vdp-search-tooltip");
      badge.setAttribute("aria-expanded", "false");
      badge.setAttribute("aria-label", "Checking pet policy");
      badge.dataset.vdpStatus = "loading";
      badge.dataset.vdpText = "Checking pet policy...";
      badge.textContent = "⏳ Checking pet policy...";

      const targetContainer = card.querySelector('[data-stid*="price"], [data-stid*="content"], .uitk-card-content') || card;
      if (targetContainer !== card) {
        targetContainer.style.position = "relative";
        targetContainer.style.zIndex = "2";
        targetContainer.style.pointerEvents = "auto";
      }
      targetContainer.appendChild(badge);

      // Dynamic handlers read card data attributes at event time
      badge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentId = card.getAttribute("data-vdp-prop-id");
        const currentFetchUrl = card.getAttribute("data-vdp-fetch-url") || card.getAttribute("data-vdp-url");
        const currentNavUrl = card.getAttribute("data-vdp-nav-url") || currentFetchUrl;
        if (currentId && currentFetchUrl) {
          showTooltipForBadge(badge, currentId, currentNavUrl, false);
        }
      });
      badge.addEventListener("mouseenter", () => {
        const currentId = card.getAttribute("data-vdp-prop-id");
        const currentFetchUrl = card.getAttribute("data-vdp-fetch-url") || card.getAttribute("data-vdp-url");
        const currentNavUrl = card.getAttribute("data-vdp-nav-url") || currentFetchUrl;
        if (currentId && currentFetchUrl) onBadgeHover(badge, currentId, currentFetchUrl, currentNavUrl, true);
      });
      badge.addEventListener("mouseleave", onBadgeLeave);
      badge.addEventListener("focus", () => {
        if (isDismissingDialog) return;
        const currentId = card.getAttribute("data-vdp-prop-id");
        const currentFetchUrl = card.getAttribute("data-vdp-fetch-url") || card.getAttribute("data-vdp-url");
        const currentNavUrl = card.getAttribute("data-vdp-nav-url") || currentFetchUrl;
        if (currentId && currentFetchUrl) onBadgeHover(badge, currentId, currentFetchUrl, currentNavUrl, true);
      });
      badge.addEventListener("blur", (e) => {
        if (e.relatedTarget && searchTooltipEl?.contains(e.relatedTarget)) return;
        scheduleTooltipHide(150);
      });
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const currentId = card.getAttribute("data-vdp-prop-id");
          const currentFetchUrl = card.getAttribute("data-vdp-fetch-url") || card.getAttribute("data-vdp-url");
          const currentNavUrl = card.getAttribute("data-vdp-nav-url") || currentFetchUrl;
          if (currentId && currentFetchUrl) {
            showTooltipForBadge(badge, currentId, currentNavUrl, true);
          }
        } else if (e.key === "Escape") {
          hideTooltip();
        }
      });
    } else if (prevId && prevId !== propId) {
      // Recycled node: dismiss open dialog if it was for previous entity, and reset old display
      if (activeTooltipTarget === badge || activeTooltipPropId === prevId) {
        hideTooltip();
      }
      badge.dataset.vdpStatus = "loading";
      badge.dataset.vdpText = "Checking pet policy...";
      badge.className = "vdp-search-badge vdp-badge-loading";
      badge.textContent = "⏳ Checking pet policy...";
      badge.setAttribute("aria-label", "Checking pet policy");
      // I3: a recycled node inherits the viewport state of the node, not of the
      // property. Enqueue only when that node is actually on screen — an
      // off-screen recycle re-binds silently and waits for the dwell gate to
      // fire when the card is scrolled into view.
      if (card._vdpInView === true) {
        enqueueSearch(propId, fetchUrl, "normal");
      }
    }

    card._vdpUnsub = searchQueue?.subscribe(propId, (data) => {
      if (card.getAttribute("data-vdp-prop-id") === propId && badge.isConnected) {
        updateBadgeUi(badge, data);
        // Live dialog update: if dialog is currently open for this badge, rerender in place
        if (
          activeTooltipTarget === badge &&
          activeTooltipPropId === propId &&
          searchTooltipEl &&
          searchTooltipEl.style.display !== "none"
        ) {
          const navUrl = card.getAttribute("data-vdp-nav-url") || card.getAttribute("data-vdp-url");
          renderTooltipContent(data, navUrl, propId, false);
          positionTooltip(badge);
        }
      }
    });

    searchQueue?.getCached(propId).then((cached) => {
      if (cached && card.getAttribute("data-vdp-prop-id") === propId) {
        updateBadgeUi(badge, cached);
      }
    });
  }

  function updateBadgeUi(badge, data) {
    if (!badge || !data) return;

    const extractLib = globalThis.VDPExtract || globalThis.VdpExtract;
    let badgeInfo = null;

    if (data.status === "ok" && data.policy && extractLib?.deriveSearchBadge) {
      badgeInfo = extractLib.deriveSearchBadge(data.policy);
    } else if (data.status === "capped") {
      badgeInfo = {
        statusKey: "capped",
        icon: "🐾",
        text: "Hover or open listing",
        className: "vdp-search-badge vdp-badge-capped",
      };
    } else {
      badgeInfo = {
        statusKey: data.status || "unknown",
        icon: "🐾",
        text: "Check pet rules on listing",
        className: "vdp-search-badge vdp-badge-unknown",
      };
    }

    if (badge.dataset.vdpStatus === badgeInfo.statusKey && badge.dataset.vdpText === badgeInfo.text) return;
    badge.dataset.vdpStatus = badgeInfo.statusKey;
    badge.dataset.vdpText = badgeInfo.text;
    // Report where this result came from: the search page's own Apollo
    // state (no listing fetch) or a listing-page fetch.
    badge.dataset.vdpSource = data.status === "ok"
      ? (data._source || "listing-fetch")
      : (data.status || "unknown");
    badge.className = badgeInfo.className;
    badge.setAttribute("aria-label", badgeInfo.text);

    badge.textContent = "";
    const iconSpan = document.createElement("span");
    iconSpan.className = "vdp-badge-icon";
    iconSpan.textContent = badgeInfo.icon;
    const textSpan = document.createElement("span");
    textSpan.className = "vdp-badge-text";
    textSpan.textContent = " " + badgeInfo.text;
    badge.appendChild(iconSpan);
    badge.appendChild(textSpan);
  }

  function onBadgeHover(badge, propId, fetchUrl, navUrl, isHighPriority) {
    clearTooltipLeaveTimer();
    const parentCard = badge.closest ? badge.closest("[data-vdp-prop-id]") : null;
    if (parentCard && parentCard._vdpDwellTimer) {
      clearTimeout(parentCard._vdpDwellTimer);
      parentCard._vdpDwellTimer = null;
    }
    if (isHighPriority && searchQueue) {
      enqueueSearch(propId, fetchUrl, "high");
    }
    showTooltipForBadge(badge, propId, navUrl || fetchUrl, false);
  }

  function onBadgeLeave(e) {
    if (e.relatedTarget && searchTooltipEl?.contains(e.relatedTarget)) return;
    scheduleTooltipHide(200);
  }

  function showTooltipForBadge(badge, propId, url, isKeyboard = false) {
    if (!searchTooltipEl) return;
    clearTooltipLeaveTimer();
    activeTooltipTarget = badge;
    activeTooltipPropId = propId;
    badge.setAttribute("aria-expanded", "true");

    searchQueue?.getCached(propId).then((cached) => {
      // Async scope guard: verify active target, propId, element connectivity, and parent card propId
      const parentCard = badge.closest ? badge.closest("[data-vdp-prop-id]") : null;
      if (
        activeTooltipTarget !== badge ||
        activeTooltipPropId !== propId ||
        !badge.isConnected ||
        (parentCard && parentCard.getAttribute("data-vdp-prop-id") !== propId)
      ) {
        return;
      }
      renderTooltipContent(cached, url, propId, isKeyboard);
      positionTooltip(badge);
    });
  }

  function renderTooltipContent(data, url, propId, isKeyboard = false) {
    if (!searchTooltipEl) return;
    const hadFocusInside = document.activeElement && searchTooltipEl.contains(document.activeElement);
    searchTooltipEl.textContent = "";

    const header = document.createElement("div");
    header.className = "vdp-tooltip-header";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = "Dog policy";
    const closeBtn = document.createElement("button");
    closeBtn.className = "vdp-tooltip-close";
    closeBtn.setAttribute("aria-label", "Close details");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      const toFocus = activeTooltipTarget;
      isDismissingDialog = true;
      hideTooltip();
      toFocus?.focus();
      setTimeout(() => { isDismissingDialog = false; }, 150);
    });
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    searchTooltipEl.appendChild(header);

    const addRow = (label, valueText, toneClass) => {
      const row = document.createElement("div");
      row.className = "vdp-tooltip-row";
      const lbl = document.createElement("span");
      lbl.className = "vdp-tooltip-label";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.className = "vdp-tooltip-val" + (toneClass ? " " + toneClass : "");
      val.textContent = valueText;
      row.appendChild(lbl);
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    };

    const p = (data && data.policy) ? data.policy : data;

    if (!data || data.status === "loading") {
      const row = document.createElement("div");
      row.className = "vdp-tooltip-row";
      const val = document.createElement("span");
      val.className = "vdp-tooltip-val";
      val.textContent = "Checking the listing summary for pet rules...";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    } else if (p && (data.status === "ok" || p.petsAllowed !== undefined || p.restrictionsFound !== undefined || p.maxDogs !== undefined || p.fee !== undefined)) {

      let rowsAdded = 0;

      if (p.petsAllowed !== null) {
        const statusText = p.petsAllowed === true ? "Yes" : "No";
        const statusTone = p.petsAllowed === true ? "vdp-tone-good" : "vdp-tone-bad";
        addRow("Dogs allowed", statusText, statusTone);
        rowsAdded++;
      } else if (p.approvalRequired || p.restrictionsFound || (p.restrictionNoteCount && p.restrictionNoteCount > 0)) {
        addRow("Pet policy", "Pet restrictions apply", "vdp-tone-warn");
        rowsAdded++;
      }
      if (p.maxDogs !== null) {
        addRow("Maximum dogs", String(p.maxDogs));
        rowsAdded++;
      }
      if (p.weightLimit) {
        const unitStr = p.weightLimit.unit === "lb" ? "lbs" : p.weightLimit.unit;
        addRow("Weight limit", `${p.weightLimit.value} ${unitStr}`);
        rowsAdded++;
      } else if (p.weightPerDog) {
        addRow("Weight limit", String(p.weightPerDog));
        rowsAdded++;
      }
      const isTieredFee = p.fee?.tiered || (p.fee?.text && /\$0\s+(?:1st|first)/i.test(p.fee.text));
      if (isTieredFee) {
        addRow("Pet fee", p.fee.text || "1st dog free, subsequent fee applies", "vdp-tone-warn");
        rowsAdded++;
      } else if (p.fee && p.fee.amount !== null) {
        const curSym = p.fee.currency === "USD" ? "$" : `${p.fee.currency} `;
        let perStr = "";
        if (p.fee.perPet && p.fee.period && p.fee.period !== "unknown" && p.fee.period !== "pet") {
          perStr = ` per pet per ${p.fee.period}`;
        } else if (p.fee.period && p.fee.period !== "unknown") {
          perStr = ` per ${p.fee.period}`;
        }
        addRow("Pet fee", `${curSym}${p.fee.amount}${perStr}`);
        rowsAdded++;
      } else if (p.fee) {
        const feeText = typeof p.fee === "string" ? p.fee : (p.fee.text || "Pet fee applies");
        addRow("Pet fee", feeText, "vdp-tone-warn");
        rowsAdded++;
      }
      if (p.deposit && p.deposit.amount !== null) {
        const curSym = p.deposit.currency === "USD" ? "$" : `${p.deposit.currency} `;
        addRow("Pet deposit", `${curSym}${p.deposit.amount}`);
        rowsAdded++;
      } else if (p.deposit) {
        const depText = typeof p.deposit === "string" ? p.deposit : (p.deposit.text || "Deposit applies");
        addRow("Pet deposit", depText, "vdp-tone-warn");
        rowsAdded++;
      }
      if (p.approvalRequired === true || p.preReg === true) {
        addRow("Prior approval", "Required", "vdp-tone-warn");
        rowsAdded++;
      }

      if (rowsAdded === 0) {
        addRow("Pet policy", "Check listing for complete rules");
      }

      // Contradiction summary
      const hasConflict = p.contradictions?.maxDogs ||
        p.contradictions?.weightLimit ||
        p.contradictions?.fee ||
        p.maxDogsAlternates?.length ||
        p.weightAlternates?.length ||
        p.feeAlternates?.length;

      if (hasConflict) {
        const warnBox = document.createElement("div");
        warnBox.className = "vdp-tooltip-notes vdp-tone-warn";
        warnBox.innerHTML = "⚠️ <strong>Some pet-policy details conflict.</strong><br>Open the listing to verify the complete rules.";
        searchTooltipEl.appendChild(warnBox);
      }
    } else if (data.status === "rate_limited") {
      const row = document.createElement("div");
      row.className = "vdp-tooltip-row";
      const val = document.createElement("span");
      val.className = "vdp-tooltip-val";
      val.textContent = "Pet policy lookup paused due to request limits.";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    } else if (data.status === "capped") {
      const row = document.createElement("div");
      row.className = "vdp-tooltip-row";
      const val = document.createElement("span");
      val.className = "vdp-tooltip-val";
      val.textContent = "Background check paused to protect session limits.";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    } else {
      // Unavailable / Fallback (unknown, timeout, error)
      const row = document.createElement("div");
      row.className = "vdp-tooltip-row";
      const val = document.createElement("span");
      val.className = "vdp-tooltip-val";
      val.textContent = "Pet policy details were not available in the search result.";
      row.appendChild(val);
      searchTooltipEl.appendChild(row);
    }

    const footer = document.createElement("div");
    footer.className = "vdp-tooltip-footer";
    const link = document.createElement("a");
    if (typeof url === "string" && (url.startsWith("https://www.vrbo.com/") || url.startsWith("/"))) {
      link.href = url;
    } else {
      link.href = "#";
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open listing for complete rules ↗";
    footer.appendChild(link);
    searchTooltipEl.appendChild(footer);

    if (isKeyboard || hadFocusInside) {
      setTimeout(() => closeBtn.focus(), 10);
    }
  }

  function positionTooltip(badge) {
    if (!searchTooltipEl || !badge) return;
    searchTooltipEl.style.display = "block";
    const rect = badge.getBoundingClientRect();
    const tooltipHeight = searchTooltipEl.offsetHeight || 180;
    const tooltipWidth = 290;

    let top = rect.bottom + 4;
    if (top + tooltipHeight > window.innerHeight - 10) {
      top = Math.max(10, rect.top - tooltipHeight - 4);
    }

    let left = rect.left;
    if (left + tooltipWidth > window.innerWidth - 16) {
      left = Math.max(16, window.innerWidth - tooltipWidth - 16);
    }

    searchTooltipEl.style.top = `${top}px`;
    searchTooltipEl.style.left = `${left}px`;
    searchTooltipEl.classList.add("vdp-tooltip-visible");
    searchTooltipEl.setAttribute("aria-hidden", "false");
  }

  function hideTooltip() {
    clearTooltipLeaveTimer();
    if (searchTooltipEl) {
      searchTooltipEl.classList.remove("vdp-tooltip-visible");
      searchTooltipEl.setAttribute("aria-hidden", "true");
      searchTooltipEl.style.display = "none";
      if (activeTooltipTarget) {
        activeTooltipTarget.setAttribute("aria-expanded", "false");
        activeTooltipTarget = null;
        activeTooltipPropId = null;
      }
    }
  }

  function onUrlMaybeChanged() {
    if (location.href !== lastScannedUrl) {
      lastScannedUrl = location.href;
      hideTooltip();

      if (isSearchUrl(location.href)) {
        removePanel();
        // I7: search -> search keeps the queue object, and with it the session
        // request budget; only the per-card state of the previous result set is
        // dropped. The search -> listing branch below still disposes outright.
        pruneStaleSearchCards();
        chrome.storage?.local?.get?.(["vrbow_enable_search_badging"], (data) => {
          if (data && data.vrbow_enable_search_badging === true) initSearchManager();
        });
      } else if (isListingUrl(location.href)) {
        cleanupSearchManager();
        removePanel();
        latestApolloPayload = null;
        harvestedDialogText = [];
        harvestedForUrl = null;
        window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));
        scheduleRescan(1200);
        setTimeout(() => scan(false), 3200);
      } else {
        cleanupSearchManager();
        removePanel();
      }
    }
  }

  // Bridge data listener (page-bridge.js runs in the MAIN world).
  window.addEventListener("vdp-apollo-data", (e) => {
    latestApolloPayload = e.detail;
    scheduleRescan(150);
  });
  // Search-page Apollo fast path: the bridge answers this request
  // synchronously while the request event is still dispatching, so
  // requestSearchApolloData() can read the fresh payload in the same tick.
  window.addEventListener("vdp-search-apollo-data", (e) => {
    latestSearchApolloData = e.detail;
  });
  // Ask the bridge for whatever it already has, in case it fired before
  // we attached this listener.
  window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));

  // SPA navigation detection
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("vdp-locationchange")));
  window.addEventListener("vdp-locationchange", onUrlMaybeChanged);
  setInterval(onUrlMaybeChanged, 1000);

  // MutationObserver, attached to document.body which permanently survives
  // SPA <main> swaps. Panel is attached to document.documentElement (outside body)
  // so panel DOM mutations never trigger this observer. Debounced with a hard cap.
  function startObserver() {
    const target = document.body || document.documentElement;
    observer = new MutationObserver((mutations) => {
      if (suppressObserver) return;

      // Ignore internal mutations on Vrbow's own badges or tooltips
      if (mutations && mutations.length) {
        let onlyInternal = true;
        for (const m of mutations) {
          const el = m.target;
          if (!el || !el.closest || (!el.closest(".vdp-search-badge") && !el.closest(".vdp-search-tooltip") && !el.closest("#vdp-panel"))) {
            onlyInternal = false;
            break;
          }
        }
        if (onlyInternal) return;
      }

      const now = Date.now();
      if (!mutationFirstSeenAt) mutationFirstSeenAt = now;
      const elapsed = now - mutationFirstSeenAt;

      if (isSearchUrl(location.href)) {
        if (typeof searchQueue !== "undefined" && searchQueue !== null) {
          requestSearchScan();
        }
      } else {
        if (elapsed > 4000) {
          mutationFirstSeenAt = 0;
          scheduleRescan(0);
        } else {
          scheduleRescan(900);
        }
      }
    });
    observer.observe(target, { childList: true, subtree: true });
  }
  startObserver();

  // initial run
  chrome.storage?.local?.get?.(["vrbow_enable_search_badging"], (data) => {
    const searchBadgingEnabled = data ? data.vrbow_enable_search_badging !== false : true; // Default ON
    if (isSearchUrl(location.href)) {
      if (searchBadgingEnabled) initSearchManager();
    } else {
      scheduleRescan(1000);
      setTimeout(() => scan(false), 3500);
    }
  });

  // Listen for settings toggle live
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === "local" && changes.vrbow_enable_search_badging) {
      const enabled = changes.vrbow_enable_search_badging.newValue !== false;
      if (isSearchUrl(location.href)) {
        if (enabled) {
          initSearchManager();
        } else {
          cleanupSearchManager();
        }
      }
    }
  });

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

  // Unit-test surface (node --test). `module` does not exist in the extension's
  // isolated world, so this block is inert in the browser; it exists so the card
  // orchestration above can be driven without a real browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      __test: {
        initSearchManager,
        cleanupSearchManager,
        scanSearchCards,
        bindSearchCard,
        requestSearchScan,
        pruneStaleSearchCards,
        onUrlMaybeChanged,
        getSearchStats,
        getSearchQueue: () => searchQueue,
        getTrackedSearchCards: () => trackedSearchCards,
        getSearchCardObserver: () => searchCardObserver,
        SEARCH_SCAN_THROTTLE_MS,
      },
    };
  }
})();
