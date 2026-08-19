function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

const { escapeHtml, formatMoney } = globalThis.VdpFormatters;

function renderNotVrbo() {
  const c = document.getElementById("content");
  c.innerHTML = "";
  c.appendChild(
    el(`<p class="muted">Open a Vrbo listing page to see its dog policy summary.</p>`)
  );
}

function renderPolicy(policy) {
  const c = document.getElementById("content");
  c.innerHTML = "";

  if (!policy) {
    c.appendChild(el(`<p class="muted">No data yet. Try Rescan, or wait for the page to finish loading.</p>`));
    return;
  }

  const raw = policy._raw || policy;

  if (policy.petsAllowed === false) {
    c.appendChild(el(`<div class="row"><span class="label">Policy</span><span class="value tone-bad">No pets allowed</span></div>`));
    if (raw.petsAllowedSnippet) {
      c.appendChild(el(`<div class="snippet">"${escapeHtml(raw.petsAllowedSnippet)}"</div>`));
    }
    return;
  }

  if (!raw.found && !policy.restrictionsFound) {
    c.appendChild(el(`<p class="muted">No dog policy details detected on this page yet. Try Rescan after the page fully loads, or check House Rules manually.</p>`));
    return;
  }

  const maxDogsVal = policy.maxDogs !== null ? String(policy.maxDogs) : (raw.maxDogs !== null ? String(raw.maxDogs) : "Not specified");
  const weightVal = policy.weightLimit ? `${policy.weightLimit.value} ${policy.weightLimit.unit === "lb" ? "lbs" : policy.weightLimit.unit}` : (raw.weightPerDog || "Not specified");
  let feePerStr = "";
  if (policy.fee) {
    if (policy.fee.perPet && policy.fee.period && policy.fee.period !== "unknown" && policy.fee.period !== "pet") {
      feePerStr = ` per pet per ${policy.fee.period}`;
    } else if (policy.fee.period && policy.fee.period !== "unknown") {
      feePerStr = ` per ${policy.fee.period}`;
    }
  }
  const feeVal = policy.fee && policy.fee.amount !== null
    ? `${formatMoney(policy.fee.amount, policy.fee.currency)}${feePerStr}`
    : (raw.fee || "Not specified");

  const preRegVal = (policy.approvalRequired || raw.preReg) ? "Required" : "Not mentioned";

  const rows = [
    ["Max dogs", maxDogsVal, maxDogsVal !== "Not specified" ? "good" : "unknown"],
    ["Weight limit", weightVal, weightVal !== "Not specified" ? "good" : "unknown"],
    ["Pre-registration", preRegVal, preRegVal === "Required" ? "warn" : "unknown"],
    ["Fee", feeVal, policy.fee && policy.fee.amount > 0 ? "warn" : policy.fee && policy.fee.amount === 0 ? "good" : (raw.fee && raw.fee !== "No fee mentioned" ? "warn" : "unknown")],
  ];

  if (policy.deposit || raw.deposit) {
    const depVal = policy.deposit && policy.deposit.amount !== null ? formatMoney(policy.deposit.amount, policy.deposit.currency) : raw.deposit;
    rows.push(["Refundable deposit", depVal, "warn"]);
  }

  for (const [label, value, tone] of rows) {
    c.appendChild(
      el(`<div class="row"><span class="label">${label}</span><span class="value tone-${tone}">${escapeHtml(value)}</span></div>`)
    );
  }

  const notes = raw.otherNotes || [];
  if (notes.length) {
    c.appendChild(el(`<p class="muted" style="margin-top:8px;">+ ${notes.length} other pet note(s) — see the on-page panel for details.</p>`));
  }
}

function withActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    cb(tab);
  });
}

function isSearchUrl(urlStr) {
  const site = globalThis.VdpSiteRegistry?.getSiteForUrl(urlStr);
  return site ? site.isSearchUrl(urlStr) : false;
}

function renderSearchPageNotice() {
  const c = document.getElementById("content");
  c.innerHTML = "";
  c.appendChild(
    el(`<p class="muted">You are on a search results page. Pet policy badges and quick-view tooltips appear directly on each listing card below.</p>`)
  );
}

function isListingUrl(urlStr) {
  const site = globalThis.VdpSiteRegistry?.getSiteForUrl(urlStr);
  return site ? site.isListingUrl(urlStr) : false;
}

function loadPolicy() {
  withActiveTab((tab) => {
    if (!tab || !tab.url) {
      renderNotVrbo();
      return;
    }
    if (isSearchUrl(tab.url)) {
      renderSearchPageNotice();
      return;
    }
    if (!isListingUrl(tab.url)) {
      renderNotVrbo();
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "vdp-get-policy" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.policy) {
        // Content script may not have responded yet (e.g. page still
        // loading) — fall back to the last result it cached to storage.
        chrome.storage?.local?.get?.(["vdpLastPolicy", "vdpLastUrl"], (data) => {
          if (data && data.vdpLastUrl === tab.url && data.vdpLastPolicy) {
            renderPolicy(data.vdpLastPolicy);
          } else {
            renderPolicy(null);
          }
        });
        return;
      }
      renderPolicy(resp.policy);
    });
  });
}

document.getElementById("rescan").addEventListener("click", () => {
  document.getElementById("content").innerHTML = '<p class="status-tone tone-loading">Rescanning…</p>';
  withActiveTab((tab) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: "vdp-rescan" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        renderPolicy(null);
        return;
      }
      renderPolicy(resp.policy);
    });
  });
});

loadPolicy();


// Settings Logic
const toggleSearchBadging = document.getElementById("toggle-search-badging");
if (toggleSearchBadging && chrome.storage && chrome.storage.local) {
  // Load initial state (Default ON/true)
  chrome.storage.local.get(["vrbow_enable_search_badging"], (data) => {
    toggleSearchBadging.checked = data ? data.vrbow_enable_search_badging !== false : true;
  });

  // Save state on change
  toggleSearchBadging.addEventListener("change", (e) => {
    chrome.storage.local.set({ vrbow_enable_search_badging: e.target.checked });
  });
}
