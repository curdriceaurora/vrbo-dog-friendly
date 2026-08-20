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
  const { escapeHtml } = globalThis.VdpFormatters;

  function getSiteRegistry() {
    if (globalThis.VdpSiteRegistry) return globalThis.VdpSiteRegistry;
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[vrbow] VdpSiteRegistry is unavailable; check script load order");
    }
    return null;
  }

  function getListingIdFromUrl(urlStr) {
    const reg = getSiteRegistry();
    return reg ? reg.getPropertyId(urlStr || location.href) : null;
  }

  function isListingUrl(urlStr) {
    const reg = getSiteRegistry();
    return reg ? reg.isListingUrl(urlStr || location.href) : false;
  }

  function isSearchUrl(urlStr) {
    const reg = getSiteRegistry();
    return reg ? reg.isSearchUrl(urlStr || location.href) : false;
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
        if (el.closest(OFF_LIMITS)) return false;
        const label = (el.textContent || el.getAttribute("aria-label") || "").trim();
        const isToggle = TOGGLE_TEXT_RE.test(label);
        const isAriaFalse = el.getAttribute("aria-expanded") === "false";
        if (!isToggle && !isAriaFalse) return false;
        if (!isToggle && isAriaFalse && !inRelevantSection(el)) return false;
        if (!(el.offsetParent !== null || el.getClientRects().length > 0)) return false;
        return true;
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

  const QUICK_PET_CHECK = /\b(pets?|dogs?|canines?)\b/i;

  function collectDomPetSentences() {
    const root = document.querySelector("main") || document.body;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
      const rawText = node.textContent && node.textContent.trim();
      if (!rawText || !QUICK_PET_CHECK.test(rawText)) continue;
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
    const root = document.querySelector("main") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

  let panelResizeListener = null;
  let lastPanelMode = null; // 'beside' | 'constrained' | null
  let lastUserCollapsed = null; // boolean | null

  function updatePanelPosition(panel, isInitial) {
    if (!panel || !panel.isConnected) return;
    const renderer = document.querySelector('[data-stid="lodging-infosite-template-api-renderer"]');
    const BESIDE_WIDTH = 340;
    // Hysteresis deadband: require >=350px margin to enter beside mode,
    // but only drop back to constrained mode if margin falls below 340px (panel width).
    const BESIDE_ENTER_MARGIN = 350;
    const BESIDE_EXIT_MARGIN = 340;

    let isBeside = false;
    let gap = 16;
    if (renderer) {
      const rect = renderer.getBoundingClientRect();
      const freeSpaceRight = window.innerWidth - rect.right;
      const threshold = lastPanelMode === "beside" ? BESIDE_EXIT_MARGIN : BESIDE_ENTER_MARGIN;

      if (freeSpaceRight >= threshold) {
        isBeside = true;
        gap = Math.max(10, Math.min(16, Math.floor((freeSpaceRight - BESIDE_WIDTH) / 2)));
        panel.style.left = `${Math.round(rect.right + gap)}px`;
        panel.style.right = "auto";
        panel.classList.add("vdp-beside");
      }
    }

    if (!isBeside) {
      panel.style.left = "auto";
      panel.style.right = "16px";
      panel.classList.remove("vdp-beside");
    }

    const currentMode = isBeside ? "beside" : "constrained";
    const modeChanged = lastPanelMode !== currentMode;
    lastPanelMode = currentMode;

    const header = panel.querySelector(".vdp-header");

    if (modeChanged) {
      if (isBeside) {
        panel.classList.remove("vdp-collapsed");
        if (header) header.setAttribute("aria-expanded", "true");
        lastUserCollapsed = false;
      } else {
        panel.classList.add("vdp-collapsed");
        if (header) header.setAttribute("aria-expanded", "false");
        lastUserCollapsed = true;
      }
    } else if (isInitial && lastUserCollapsed !== null) {
      if (lastUserCollapsed) {
        panel.classList.add("vdp-collapsed");
        if (header) header.setAttribute("aria-expanded", "false");
      } else {
        panel.classList.remove("vdp-collapsed");
        if (header) header.setAttribute("aria-expanded", "true");
      }
    }
  }

  function removePanel(resetSession) {
    if (panelResizeListener) {
      window.removeEventListener("resize", panelResizeListener);
      panelResizeListener = null;
    }
    if (resetSession) {
      lastPanelMode = null;
      lastUserCollapsed = null;
    }
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  // Real source strings can be a combined "Section > Header" (see
  // formatSourceLabel in extract.js) — for the compact per-row jump link
  // we only want the lowest-level, linkable label (the header the
  // snippet actually lives under), not the full hierarchy.
  //
  // Several sources never get a distinct header at all: the DOM
  // text-scan fallback (findSectionHeadingForElement) only ever returns
  // one of a handful of coarse section names, so there's no ">" to split
  // on and the full name ("House Rules / Policies", 23 chars) would blow
  // right past the jump-link's column budget. Map those known coarse
  // names down to the same short form the Apollo "Section > Header" path
  // would have produced for an equivalent header.
  const SHORT_SECTION_LABELS = {
    "house rules / policies": "House Rules",
    "about this property": "About",
    "property amenities": "Amenities",
    "about the host": "Host",
    "questions & answers": "Q&A",
    "guest reviews": "Reviews",
    "listing details": "Listing",
    "visible page text": "Page text",
  };
  function shortSourceLabel(source) {
    if (!source) return "";
    const parts = source.split(">").map((p) => p.trim()).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : source.trim();
    return SHORT_SECTION_LABELS[last.toLowerCase()] || last;
  }

  // `value` is always escaped. Today every caller passes a literal or a
  // digits-only regex capture, so nothing can break out — but escaping
  // here means a future pattern that captures freeform listing text
  // can't turn into an injection point.
  //
  // `valueLines`, when passed, renders a genuinely compound value (e.g.
  // two fee conditions, two weight-limit clauses) as separate stacked
  // lines instead of one comma-joined sentence — the row grows taller,
  // the column never grows wider. Left unset for anything not already
  // structured as distinct pieces; we don't attempt to split arbitrary
  // freeform extracted text on commas, since a comma there isn't
  // reliably a clause boundary.
  function row(label, value, tone, snippet, source, alternates, valueLines) {
    const toneClass = tone ? `vdp-tone-${tone}` : "";
    const jumpAttr = snippet ? `data-snippet="${encodeURIComponent(snippet)}" data-source="${encodeURIComponent(source || "")}"` : "";
    const jumpBtn = snippet
      ? `<button type="button" class="vdp-jump" ${jumpAttr} title="Jump to where this was found in ${escapeHtml(source || "the listing")}">${escapeHtml(shortSourceLabel(source))} <span class="vdp-jump-arrow">↗</span></button>`
      : "";
    const altHtml =
      alternates && alternates.length
        ? `<div class="vdp-alt">⚠ Listing also states elsewhere: ${alternates
            .map((a) => `<strong>${escapeHtml(a.value)}</strong> (${escapeHtml(a.source || "")})`)
            .join("; ")}</div>`
        : "";
    const valueHtml =
      valueLines && valueLines.length > 1
        ? valueLines.map((line) => `<span class="vdp-value-line">${escapeHtml(line)}</span>`).join("")
        : escapeHtml(value);
    return `<div class="vdp-row">
      <span class="vdp-label">${label}</span>
      <span class="vdp-value ${toneClass}">${valueHtml}${altHtml}</span>
      ${jumpBtn}
    </div>`;
  }

  function renderPanel(policy) {
    removePanel();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    let rowsHtml = "";
    let headline = "";
    let headlineTone = "neutral";
    let isFullySparse = false;
    const raw = policy._raw || policy;

    // Computed up front (not just for the footer) because the sparse
    // branch below folds this same text into its one summary line
    // instead of also rendering a separate footer.
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

    // Title stays a static "Dog policy" across every state — matching the
    // search tooltip's header, which never changes text either — so the
    // panel and tooltip read as the same widget. Status is conveyed by
    // headlineTone (the header's background color) and the row/body
    // content below, not by swapping the title itself.
    headline = "Dog policy";
    if (policy.petsAllowed === false) {
      headlineTone = "bad";
      rowsHtml = row("Policy", "No pets allowed", "bad", raw.petsAllowedSnippet, raw.petsAllowedSource);
    } else if (!raw.found && !policy.restrictionsFound) {
      headlineTone = "unknown";
      rowsHtml = `<div class="vdp-empty">This page didn't mention pets/dogs in its listing data or visible text. Try Rescan after the page fully loads, or check House Rules manually.</div>`;
    } else {
      headlineTone = policy.petsAllowed === true ? "good" : "unknown";

      const notes = raw.otherNotes || [];
      const hasWeight = Boolean(policy.weightLimit || raw.weightPerDog);
      const hasPreReg = Boolean(policy.approvalRequired || raw.preReg);
      const hasFeeAmount = Boolean(policy.fee && policy.fee.amount !== null);
      const hasFeeText = Boolean(raw.fee);

      isFullySparse =
        policy.maxDogs === null &&
        !hasWeight &&
        !hasPreReg &&
        !hasFeeAmount &&
        !hasFeeText &&
        !policy.deposit &&
        !raw.deposit &&
        !notes.length;

      if (isFullySparse) {
        // Every core field came back unconfirmed — a four-row table of
        // "Not specified" would give that absence the same structural
        // weight as a real finding. Collapse to one muted line instead;
        // still names exactly what was checked, just not as row markup.
        rowsHtml = `<div class="vdp-unconfirmed">
          <p class="vdp-unconfirmed-text">Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.</p>
          ${sourceBadge ? `<span class="vdp-unconfirmed-src">${escapeHtml(sourceBadge)}</span>` : ""}
        </div>`;
      } else {
        rowsHtml += `<div class="vdp-group-hd">Dog limits</div>`;
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
          hasWeight ? "good" : "unknown",
          raw.weightSnippet,
          raw.weightSource,
          raw.weightAlternates
        );
        rowsHtml += `<div class="vdp-group-hd">Cost &amp; approval</div>`;
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
        let feeValueLines = null;
        if (isTieredFee) {
          if (policy.fee.text) {
            // Extracted freeform text — its shape isn't guaranteed to be
            // two clean clauses, so it's shown as a single value rather
            // than guessed-split on a comma that might not be a clause
            // boundary.
            feeDisplay = policy.fee.text;
          } else {
            // feeDisplay stays unset here — row() renders feeValueLines
            // instead and never reads the plain-string value once it has
            // more than one line.
            feeValueLines = ["1st dog free", "subsequent fee applies"];
          }
        } else if (hasFeeAmount) {
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
          raw.feeAlternates,
          feeValueLines
        );
        if (policy.deposit || raw.deposit) {
          const depDisplay = policy.deposit && policy.deposit.amount !== null
            ? (typeof VDPExtract?.formatCurrencyDisplay === "function" ? VDPExtract.formatCurrencyDisplay(policy.deposit.amount, policy.deposit.currency) : `$${policy.deposit.amount}`)
            : raw.deposit;
          rowsHtml += row("Refundable deposit", depDisplay, "warn", raw.depositSnippet, raw.depositSource);
        }
        rowsHtml += row(
          "Pre-registration",
          hasPreReg ? "Required" : "Not mentioned",
          hasPreReg ? "warn" : "unknown",
          raw.preRegSnippet,
          raw.preRegSource
        );

        if (notes.length) {
          // Repeated attribution reads as noise, not signal: two snippets
          // from the same source get one card (one shared source line)
          // instead of two near-identical cards. Grouped by first
          // appearance, not sorted — but the "(N)" count still reflects
          // total snippets found, since that's "how many facts", separate
          // from how they're packaged into cards.
          const groups = [];
          const bySource = new Map();
          for (const n of notes) {
            const key = n.source || "";
            let group = bySource.get(key);
            if (!group) {
              group = { source: n.source, quotes: [] };
              bySource.set(key, group);
              groups.push(group);
            }
            group.quotes.push(n.text);
          }
          rowsHtml += `<div class="vdp-other-toggle">Other pet notes (${notes.length}) ▾</div>
            <div class="vdp-other-list">
              ${groups
                .map(
                  (g) =>
                    `<div class="vdp-other-item">${g.quotes
                      .map((q) => `<span class="vdp-other-quote">"${escapeHtml(q)}"</span>`)
                      .join("")}<span class="vdp-other-source">— ${escapeHtml(g.source)}</span></div>`
                )
                .join("")}
            </div>`;
        }
      }
    }

    panel.innerHTML = `
      <div class="vdp-header vdp-tone-${headlineTone}" tabindex="0" role="button" aria-expanded="true" aria-label="Toggle dog policy details">
        <span class="vdp-title">${headline}</span>
        <div class="vdp-header-btns">
          <button type="button" class="vdp-rescan" title="Rescan page">↻</button>
          <button type="button" class="vdp-close" title="Close">×</button>
        </div>
      </div>
      <div class="vdp-body">
        ${rowsHtml}
        ${!isFullySparse && sourceBadge ? `<div class="vdp-source-badge">${sourceBadge}</div>` : ""}
      </div>
    `;

    document.documentElement.appendChild(panel);
    updatePanelPosition(panel, true);

    if (panelResizeListener) {
      window.removeEventListener("resize", panelResizeListener);
    }
    panelResizeListener = () => {
      updatePanelPosition(panel, false);
    };
    window.addEventListener("resize", panelResizeListener);

    panel.querySelector(".vdp-close").addEventListener("click", () => removePanel());
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
    const toggleCollapse = (e) => {
      if (e.target.closest("button")) return;
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.type === "keydown") e.preventDefault();
      panel.classList.toggle("vdp-collapsed");
      const isCollapsed = panel.classList.contains("vdp-collapsed");
      lastUserCollapsed = isCollapsed;
      header.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    };
    header.addEventListener("click", toggleCollapse);
    header.addEventListener("keydown", toggleCollapse);
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
  const cardsByPropertyId = new Map(); // propertyId -> Set<card element> for O(1) duplicate checks

  function trackCardPropId(propId, card) {
    if (!propId || !card) return;
    let set = cardsByPropertyId.get(propId);
    if (!set) {
      set = new Set();
      cardsByPropertyId.set(propId, set);
    }
    set.add(card);
  }

  function untrackCardPropId(propId, card) {
    if (!propId) return;
    const set = cardsByPropertyId.get(propId);
    if (set) {
      if (card) set.delete(card);
      for (const node of set) {
        if (!node || !node.isConnected) set.delete(node);
      }
      if (set.size === 0) cardsByPropertyId.delete(propId);
    }
  }

  // I9: mutation-driven scans run on a leading-edge throttle. The first scan of
  // a burst runs synchronously (card binding must not lag a re-render), the rest
  // of the burst collapses into one trailing scan.
  const SEARCH_SCAN_THROTTLE_MS = 250;
  let lastSearchScanAt = 0;
  let searchScanThrottleTimer = null;

  // Scroll velocity tracking & settle detection (Issue #23)
  const SCROLL_VELOCITY_THRESHOLD_PX_S = 150;
  const SCROLL_SETTLE_DEBOUNCE_MS = 150;

  let lastScrollY = 0;
  let lastScrollTime = 0;
  let scrollRafId = null;
  let scrollSettleTimer = null;
  let isScrollPaused = false;
  let scrollListenersAttached = false;

  function onWindowScroll() {
    if (scrollRafId !== null) return; // Coalesce to one computation per frame

    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      const now = performance.now();
      const currentY = typeof window !== "undefined" ? (window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0) : 0;

      // Explicit first-event guard: initialize baseline without a false-positive
      // velocity spike. performance.now() is never exactly 0 once any time has
      // elapsed since navigation start, so this sentinel is unambiguous.
      if (lastScrollTime === 0) {
        lastScrollY = currentY;
        lastScrollTime = now;
        return;
      }

      const dt = now - lastScrollTime;
      if (dt > 0) {
        const velocity = (Math.abs(currentY - lastScrollY) / dt) * 1000;
        lastScrollY = currentY;
        lastScrollTime = now;

        if (velocity >= SCROLL_VELOCITY_THRESHOLD_PX_S && !isScrollPaused) {
          isScrollPaused = true;
          if (searchQueue && typeof searchQueue.setScrollPaused === "function") {
            searchQueue.setScrollPaused(true);
          }
        }
      }

      // Reset trailing settle debounce on every frame while scroll activity continues
      if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(onScrollSettled, SCROLL_SETTLE_DEBOUNCE_MS);
    });
  }

  function onScrollSettled() {
    if (scrollSettleTimer !== null) {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    }
    if (isScrollPaused) {
      isScrollPaused = false;
      if (searchQueue && typeof searchQueue.setScrollPaused === "function") {
        searchQueue.setScrollPaused(false);
      }
    }
  }

  // #18: mount priority for the badge, most to least preferred. This MUST be
  // tried one selector at a time. A single querySelector() with all three joined
  // by commas returns the first match in DOCUMENT ORDER, not the first selector
  // that matches — so on a card whose price element precedes its content column,
  // the badge lands in the narrow price box. That was invisible while the badge
  // was inline-flex and sized to its own text; once width is a percentage, the
  // container becomes the layout.
  const BADGE_CONTAINER_SELECTORS = [
    ".uitk-card-content",
    '[data-stid*="content"]',
    '[data-stid*="price"]',
  ];

  // Static query selector for search cards across desktop/mobile Vrbo layouts
  const DEFAULT_CARD_SELECTORS_QUERY = [
    '[data-stid="property-card"]',
    '[data-stid="lodging-card-responsive"]',
    '[data-testid="property-card"]',
    'article[data-stid*="card"]',
    'div[data-stid*="property-card"]',
  ].join(", ");

  function getSearchCardSelector() {
    const reg = getSiteRegistry();
    return reg?.getSearchCardSelector(location.href) || DEFAULT_CARD_SELECTORS_QUERY;
  }

  function resolveBadgeContainer(card) {
    const reg = getSiteRegistry();
    const selectors = reg?.getCardContentSelector(location.href) || BADGE_CONTAINER_SELECTORS;
    const list = Array.isArray(selectors) ? selectors : selectors.split(",").map((s) => s.trim());
    for (const selector of list) {
      const match = card.querySelector(selector);
      if (match) return match;
    }
    return card;
  }

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
      // Enqueue CALLS handed to the queue engine, not network requests. A call that
      // resolves from cache issues no fetch, so this is an upper bound on traffic.
      // For the true network count read `networkRequests` below.
      enqueued: 0,
      // Queue items actually withdrawn by remove() on viewport exit. This is I8b's
      // numerator in #23's "pruned by I8b versus dispatched" ratio.
      prunedOffscreen: 0,
      // Queue items actually withdrawn when a node was recycled to another property.
      prunedRecycled: 0,
      // CARDS dropped from tracking on an SPA re-render. Counted per card, not per
      // queue withdrawal, so it is NOT comparable to the two counters above.
      prunedStale: 0,
      lastQueueDepth: 0,
      maxQueueDepth: 0,
      depthSamples: [], // [{ t, depth, staged, reason }], bounded ring
      depthSamplesDropped: 0, // Samples evicted by the ring; nonzero means truncated history
    };
  }

  function resetSearchStats() {
    searchStats = createEmptySearchStats();
  }

  function sampleQueueDepth(reason) {
    if (!searchQueue || typeof searchQueue.getQueueLength !== "function") return;
    // enqueue() stages an item behind an async getCached() before pushing it to the
    // queue array, so getQueueLength() alone undercounts by whatever is still
    // staging — and under sustained scroll, which is the regime #23 gates on, that
    // is exactly when the staged population is nonzero. Record both.
    const queued = searchQueue.getQueueLength();
    const staged = typeof searchQueue.getPendingCount === "function"
      ? searchQueue.getPendingCount()
      : 0;
    const depth = queued + staged;
    searchStats.lastQueueDepth = depth;
    if (depth > searchStats.maxQueueDepth) searchStats.maxQueueDepth = depth;
    searchStats.depthSamples.push({ t: Date.now(), depth, staged, reason });
    if (searchStats.depthSamples.length > MAX_DEPTH_SAMPLES) {
      searchStats.depthSamples.shift();
      searchStats.depthSamplesDropped++;
    }
  }

  function getSearchStats() {
    return {
      ...searchStats,
      // Read through to the queue's own session counter: the number of requests
      // actually put on the wire. This is the denominator #23's gate needs, and it
      // is not the same as `enqueued`.
      networkRequests: searchQueue && typeof searchQueue.getSessionCount === "function"
        ? searchQueue.getSessionCount()
        : 0,
      depthSamples: searchStats.depthSamples.slice(),
    };
  }

  // Read-only devtools hook. Returns a copy; nothing here is persisted or sent.
  globalThis.__vdpSearchStats = getSearchStats;

  /**
   * Checks whether another live (connected) card DOM element currently shares
   * this property ID, lazily sweeping any detached/recycled nodes encountered
   * during iteration (deleting current elements in Set iteration is well-defined).
   */
  function anotherCardHasPropId(propId, exceptCard) {
    if (!propId) return false;
    const set = cardsByPropertyId.get(propId);
    if (!set || set.size === 0) return false;
    let hasAnother = false;
    for (const node of set) {
      // Lazy sweep: prune detached nodes so they don't linger across SPA re-renders
      if (!node || !node.isConnected) {
        set.delete(node);
      } else if (node !== exceptCard) {
        hasAnother = true;
      }
    }
    if (set.size === 0) cardsByPropertyId.delete(propId);
    return hasAnother;
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
    const propertyIds = [];
    for (const id of discoveredSearchPropIds) {
      propertyIds.push(id);
      if (propertyIds.length === 40) break;
    }
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
          activeQueue.setCached(propId, fast, { persist: false }).catch(() => {}).finally(() => {
            if (searchQueue && searchQueue === activeQueue && document.querySelector(`[data-vdp-prop-id="${propId}"]`)) {
              activeQueue.enqueue(propId, url, priority);
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
      searchStats.enqueued++;
      sampleQueueDepth("enqueue");
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
      const registry = getSiteRegistry();
      if (!registry || !registry.isListingUrl(u.href)) return null;
      const propId = registry.getPropertyId(u.href);
      if (!propId) return null;
      const fetchUrl = registry.getCanonicalFetchUrl(u.href);
      return {
        propertyId: propId,
        navigationUrl: u.href,
        fetchUrl,
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

    if (!scrollListenersAttached && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("scroll", onWindowScroll, { passive: true });
      if ("onscrollend" in window) {
        window.addEventListener("scrollend", onScrollSettled, { passive: true });
      }
      scrollListenersAttached = true;
    }

    scanSearchCards();
  }

  function cleanupSearchManager() {
    hideTooltip();
    discoveredSearchPropIds.clear();
    trackedSearchCards.clear();
    cardsByPropertyId.clear();
    if (searchScanThrottleTimer) {
      clearTimeout(searchScanThrottleTimer);
      searchScanThrottleTimer = null;
    }
    lastSearchScanAt = 0;
    if (scrollRafId !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    if (scrollSettleTimer !== null) {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
    }
    if (scrollListenersAttached && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("scroll", onWindowScroll);
      if ("onscrollend" in window) {
        window.removeEventListener("scrollend", onScrollSettled);
      }
      scrollListenersAttached = false;
    }
    lastScrollY = 0;
    lastScrollTime = 0;
    isScrollPaused = false;
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
      untrackCardPropId(propId, card);
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
    const cards = document.querySelectorAll(getSearchCardSelector());
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
      trackCardPropId(propId, card);
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
      untrackCardPropId(prevId, card);
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
    trackCardPropId(propId, card);

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

      const targetContainer = resolveBadgeContainer(card);
      if (targetContainer !== card) {
        targetContainer.style.position = "relative";
        targetContainer.style.zIndex = "2";
        targetContainer.style.pointerEvents = "auto";
      }
      // #18: the badge goes in a slot the extension owns, not straight into
      // Vrbo's container. width: 100% on the badge would only behave if that
      // container happened to be a block; the slot makes the badge's width
      // independent of whether the host is block, flex-row, flex-column or grid.
      const slot = document.createElement("div");
      slot.className = "vdp-badge-slot";
      slot.appendChild(badge);
      targetContainer.appendChild(slot);

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

    searchQueue?.getCached(propId, fetchUrl).then((cached) => {
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

    searchQueue?.getCached(propId, url).then((cached) => {
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

    const addRow = (label, valueText, toneClass, valueLines = null) => {
      const row = document.createElement("div");
      row.className = "vdp-tooltip-row";
      const lbl = document.createElement("span");
      lbl.className = "vdp-tooltip-label";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.className = "vdp-tooltip-val" + (toneClass ? " " + toneClass : "");
      if (Array.isArray(valueLines) && valueLines.length > 0) {
        for (const line of valueLines) {
          const lineSpan = document.createElement("span");
          lineSpan.className = "vdp-tooltip-val-line";
          lineSpan.textContent = line;
          val.appendChild(lineSpan);
        }
      } else {
        val.textContent = valueText;
      }
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
        if (p.fee?.text) {
          addRow("Pet fee", p.fee.text, "vdp-tone-warn");
        } else {
          addRow("Pet fee", "", "vdp-tone-warn", ["1st dog free", "subsequent fee applies"]);
        }
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
    const registry = getSiteRegistry();
    if (typeof url === "string" && ((registry && registry.isListingUrl(url, location.href)) || url.startsWith("/"))) {
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
        removePanel(true);
        // I7: search -> search keeps the queue object, and with it the session
        // request budget; only the per-card state of the previous result set is
        // dropped. The search -> listing branch below still disposes outright.
        pruneStaleSearchCards();
        chrome.storage?.local?.get?.(["vrbow_enable_search_badging"], (data) => {
          if (!data || data.vrbow_enable_search_badging !== false) initSearchManager();
        });
      } else if (isListingUrl(location.href)) {
        cleanupSearchManager();
        removePanel(true);
        latestApolloPayload = null;
        harvestedDialogText = [];
        harvestedForUrl = null;
        window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));
        scheduleRescan(1200);
        setTimeout(() => scan(false), 3200);
      } else {
        cleanupSearchManager();
        removePanel(true);
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
        const INTERNAL_SELECTOR = ".vdp-search-badge, .vdp-search-tooltip, .vdp-badge-slot, #vdp-panel";
        let onlyInternal = true;
        for (const m of mutations) {
          const el = m.target;
          if (el && el.closest && el.closest(INTERNAL_SELECTOR)) continue;

          // The target itself isn't inside an internal element — this can
          // still be a purely internal mutation when it's a badge SLOT (or
          // badge) being newly inserted into a card's content column: the
          // mutation record's target is the column (the slot's new parent),
          // not the slot, so the closest() check above misses it. Check
          // addedNodes directly: if every added node is itself an internal
          // element (or contained within one), this record is internal too.
          const addedNodes = m.addedNodes;
          if (addedNodes && addedNodes.length) {
            let allAddedInternal = true;
            for (let i = 0; i < addedNodes.length; i++) {
              const node = addedNodes[i];
              // Non-element nodes (text, comments) don't have .closest — treat
              // them as non-internal so they still count toward an external mutation.
              const isInternalNode = node && node.closest && node.closest(INTERNAL_SELECTOR);
              if (!isInternalNode) {
                allAddedInternal = false;
                break;
              }
            }
            if (allAddedInternal) continue;
          }

          onlyInternal = false;
          break;
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
        expandCollapsedSections,
        onWindowScroll,
        onScrollSettled,
        getIsScrollPaused: () => isScrollPaused,
        getScrollListenersAttached: () => scrollListenersAttached,
        SCROLL_VELOCITY_THRESHOLD_PX_S,
        SCROLL_SETTLE_DEBOUNCE_MS,
      },
    };
  }
})();
