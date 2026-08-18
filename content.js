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
          if (text.trim()) harvestedDialogText.push(text);
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

  function collectDomPetSentences() {
    const root = document.querySelector("main") || document.body;
    if (!root) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent && node.textContent.trim();
      if (!text) continue;
      if (node.parentElement && node.parentElement.closest(DOM_EXCLUDE)) continue;
      parts.push(text);
    }
    // Dialogs we opened and closed again are no longer walkable, so their
    // text comes from the harvest instead — but only while we are still on
    // the listing it was taken from.
    if (harvestedForUrl === location.href) {
      for (const text of harvestedDialogText) parts.push(text);
    }
    return getSentences(parts.join("\n")).filter(isPetRelated);
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
      const policy = extractPolicy(entries);
      window.__vdpLastPolicy = policy;
      chrome.storage?.local?.set?.({ vdpLastPolicy: policy, vdpLastUrl: startUrl });
      renderPanel(policy);
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

  function initSearchManager() {
    if (!globalThis.VdpSearchFetcher) return;
    if (!searchQueue) {
      searchQueue = globalThis.VdpSearchFetcher.createSearchFetchQueue();
    }
    if (!searchTooltipEl) {
      searchTooltipEl = document.createElement("div");
      searchTooltipEl.className = "vdp-search-tooltip";
      searchTooltipEl.setAttribute("role", "tooltip");
      searchTooltipEl.setAttribute("aria-hidden", "true");
      document.body.appendChild(searchTooltipEl);
    }

    if (!searchCardObserver) {
      searchCardObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const card = entry.target;
            const propId = card.getAttribute("data-vdp-prop-id");
            const url = card.getAttribute("data-vdp-url");
            if (propId && url && searchQueue) {
              searchQueue.enqueue(propId, url, "normal");
            }
          }
        }
      }, { rootMargin: "200px 0px" });
    }

    scanSearchCards();
  }

  function scanSearchCards() {
    if (!isSearchUrl(location.href)) return;
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
  }

  function bindSearchCard(card) {
    const link = card.querySelector('a[href*="/"]');
    if (!link) return;
    const propId = getListingIdFromUrl(link.href);
    if (!propId) return;

    card.setAttribute("data-vdp-prop-id", propId);
    card.setAttribute("data-vdp-url", link.href);

    // Watch visibility for prefetching
    searchCardObserver?.observe(card);

    // Inject badge container if not present
    let badge = card.querySelector(".vdp-search-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "vdp-search-badge vdp-badge-loading";
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("aria-label", "Checking pet policy");
      badge.innerHTML = `<span class="vdp-badge-icon">⏳</span> <span class="vdp-badge-text">Checking pet policy...</span>`;

      // Try inserting into card meta/price area or append to card body
      const targetContainer = card.querySelector('[data-stid*="price"], [data-stid*="content"], .uitk-card-content') || card;
      targetContainer.appendChild(badge);

      badge.addEventListener("mouseenter", () => onBadgeHover(badge, propId, link.href, true));
      badge.addEventListener("mouseleave", onBadgeLeave);
      badge.addEventListener("focus", () => onBadgeHover(badge, propId, link.href, true));
      badge.addEventListener("blur", onBadgeLeave);
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideTooltip();
      });
    }

    // Subscribe to policy updates
    searchQueue?.subscribe(propId, (data) => updateBadgeUi(badge, data));

    // Check if already in cache
    searchQueue?.getCached(propId).then((cached) => {
      if (cached) updateBadgeUi(badge, cached);
    });
  }

  function updateBadgeUi(badge, data) {
    if (!badge || !data) return;
    if (data.status === "ok" && data.policy) {
      const p = data.policy;
      if (p.petsAllowed === false) {
        badge.className = "vdp-search-badge vdp-badge-banned";
        badge.innerHTML = `<span class="vdp-badge-icon">🚫</span> <span class="vdp-badge-text">Pets not allowed</span>`;
        badge.setAttribute("aria-label", "Pets not allowed");
      } else if (p.petsAllowed === true) {
        badge.className = "vdp-search-badge vdp-badge-allowed";
        const details = [];
        if (p.maxDogs) details.push(`${p.maxDogs} dog${p.maxDogs > 1 ? "s" : ""}`);
        if (p.weightPerDog) details.push(`≤${p.weightPerDog}`);
        if (p.fee) details.push(p.fee);
        const detailStr = details.length ? ` (${details.join(" · ")})` : "";
        badge.innerHTML = `<span class="vdp-badge-icon">🐾</span> <span class="vdp-badge-text">Dogs allowed${detailStr}</span>`;
        badge.setAttribute("aria-label", `Dogs allowed${detailStr}`);
      } else {
        badge.className = "vdp-search-badge vdp-badge-unknown";
        badge.innerHTML = `<span class="vdp-badge-icon">🐾</span> <span class="vdp-badge-text">See pet rules</span>`;
      }
    } else if (data.status === "capped") {
      badge.className = "vdp-search-badge vdp-badge-capped";
      badge.innerHTML = `<span class="vdp-badge-icon">🐾</span> <span class="vdp-badge-text">Hover for pet policy</span>`;
    } else if (data.status === "rate_limited") {
      badge.className = "vdp-search-badge vdp-badge-unknown";
      badge.innerHTML = `<span class="vdp-badge-icon">🐾</span> <span class="vdp-badge-text">View listing for rules</span>`;
    }
  }

  function onBadgeHover(badge, propId, url, isHighPriority) {
    if (isHighPriority && searchQueue) {
      searchQueue.enqueue(propId, url, "high");
    }
    showTooltipForBadge(badge, propId, url);
  }

  function onBadgeLeave(e) {
    if (e.relatedTarget && searchTooltipEl?.contains(e.relatedTarget)) return;
    hideTooltip();
  }

  function showTooltipForBadge(badge, propId, url) {
    if (!searchTooltipEl) return;
    activeTooltipTarget = badge;

    searchQueue?.getCached(propId).then((cached) => {
      renderTooltipContent(cached, url, propId);
      positionTooltip(badge);
    });
  }

  function renderTooltipContent(data, url, propId) {
    if (!searchTooltipEl) return;
    if (!data || data.status !== "ok" || !data.policy) {
      searchTooltipEl.innerHTML = `
        <div class="vdp-tooltip-header">
          <span>🐾 Dog Policy Summary</span>
          <button class="vdp-tooltip-close" aria-label="Close">×</button>
        </div>
        <div class="vdp-tooltip-row">
          <span class="vdp-tooltip-label">Status</span>
          <span class="vdp-tooltip-val">Checking policy...</span>
        </div>
        <div class="vdp-tooltip-footer">
          <a href="${url}" target="_blank" rel="noopener">Open listing details ↗</a>
        </div>
      `;
    } else {
      const p = data.policy;
      const toneClass = p.petsAllowed === true ? "vdp-tone-good" : p.petsAllowed === false ? "vdp-tone-bad" : "vdp-tone-unknown";
      const statusText = p.petsAllowed === true ? "🐾 Allowed" : p.petsAllowed === false ? "🚫 Not allowed" : "❓ Unclear";

      let rows = `
        <div class="vdp-tooltip-row">
          <span class="vdp-tooltip-label">Status</span>
          <span class="vdp-tooltip-val ${toneClass}">${statusText}</span>
        </div>
      `;

      if (p.maxDogs) {
        rows += `
          <div class="vdp-tooltip-row">
            <span class="vdp-tooltip-label">Max dogs</span>
            <span class="vdp-tooltip-val">${p.maxDogs}</span>
          </div>
        `;
      }

      if (p.weightPerDog) {
        rows += `
          <div class="vdp-tooltip-row">
            <span class="vdp-tooltip-label">Weight limit</span>
            <span class="vdp-tooltip-val">${p.weightPerDog}</span>
          </div>
        `;
      }

      if (p.fee) {
        rows += `
          <div class="vdp-tooltip-row">
            <span class="vdp-tooltip-label">Pet fee</span>
            <span class="vdp-tooltip-val">${p.fee}</span>
          </div>
        `;
      }

      if (p.deposit) {
        rows += `
          <div class="vdp-tooltip-row">
            <span class="vdp-tooltip-label">Pet deposit</span>
            <span class="vdp-tooltip-val">${p.deposit}</span>
          </div>
        `;
      }

      if (p.preReg) {
        rows += `
          <div class="vdp-tooltip-row">
            <span class="vdp-tooltip-label">Approval / Register</span>
            <span class="vdp-tooltip-val">Required</span>
          </div>
        `;
      }

      let notesHtml = "";
      if (p.otherNotes && p.otherNotes.length) {
        notesHtml = `
          <div class="vdp-tooltip-notes">
            <strong>Notes:</strong> ${p.otherNotes.slice(0, 2).map((n) => `"${n.text}"`).join("<br>")}
          </div>
        `;
      }

      searchTooltipEl.innerHTML = `
        <div class="vdp-tooltip-header">
          <span>🐾 Dog Policy Summary</span>
          <button class="vdp-tooltip-close" aria-label="Close">×</button>
        </div>
        ${rows}
        ${notesHtml}
        <div class="vdp-tooltip-footer">
          <span>Sourced locally</span>
          <a href="${url}" target="_blank" rel="noopener">Open listing ↗</a>
        </div>
      `;
    }

    searchTooltipEl.querySelector(".vdp-tooltip-close")?.addEventListener("click", hideTooltip);
  }

  function positionTooltip(badge) {
    if (!searchTooltipEl || !badge) return;
    const rect = badge.getBoundingClientRect();
    const tooltipHeight = searchTooltipEl.offsetHeight || 180;
    const tooltipWidth = 290;

    let top = rect.bottom + 8;
    if (top + tooltipHeight > window.innerHeight - 10) {
      top = Math.max(10, rect.top - tooltipHeight - 8);
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
    if (searchTooltipEl) {
      searchTooltipEl.classList.remove("vdp-tooltip-visible");
      searchTooltipEl.setAttribute("aria-hidden", "true");
      activeTooltipTarget = null;
    }
  }

  function onUrlMaybeChanged() {
    if (location.href !== lastScannedUrl) {
      lastScannedUrl = location.href;
      hideTooltip();

      if (isSearchUrl(location.href)) {
        removePanel();
        initSearchManager();
      } else if (isListingUrl(location.href)) {
        removePanel();
        latestApolloPayload = null;
        harvestedDialogText = [];
        harvestedForUrl = null;
        window.dispatchEvent(new CustomEvent("vdp-request-apollo-data"));
        scheduleRescan(1200);
        setTimeout(() => scan(false), 3200);
      } else {
        removePanel();
      }
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

  // SPA navigation detection
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("vdp-locationchange")));
  window.addEventListener("vdp-locationchange", onUrlMaybeChanged);
  setInterval(onUrlMaybeChanged, 1000);

  // MutationObserver, attached to document.body which permanently survives
  // SPA <main> swaps. Panel is attached to document.documentElement (outside body)
  // so panel DOM mutations never trigger this observer. Debounced with a hard cap.
  function startObserver() {
    const target = document.body || document.documentElement;
    observer = new MutationObserver(() => {
      if (suppressObserver) return;
      const now = Date.now();
      if (!mutationFirstSeenAt) mutationFirstSeenAt = now;
      const elapsed = now - mutationFirstSeenAt;

      if (isSearchUrl(location.href)) {
        scanSearchCards();
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
  if (isSearchUrl(location.href)) {
    initSearchManager();
  } else {
    scheduleRescan(1000);
    setTimeout(() => scan(false), 3500);
  }

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
