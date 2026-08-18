function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

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

  if (policy.petsAllowed === false) {
    c.appendChild(el(`<div class="row"><span class="label">Policy</span><span class="value tone-bad">No pets allowed</span></div>`));
    if (policy.petsAllowedSnippet) {
      c.appendChild(el(`<div class="snippet">"${escapeHtml(policy.petsAllowedSnippet)}"</div>`));
    }
    return;
  }

  if (!policy.found) {
    c.appendChild(el(`<p class="muted">No dog policy details detected on this page yet. Try Rescan after the page fully loads, or check House Rules manually.</p>`));
    return;
  }

  const rows = [
    ["Max dogs", policy.maxDogs !== null ? String(policy.maxDogs) : "Not specified", policy.maxDogs !== null ? "good" : "unknown"],
    ["Weight limit", policy.weightPerDog || "Not specified", policy.weightPerDog ? "good" : "unknown"],
    ["Pre-registration", policy.preReg ? "Required" : "Not mentioned", policy.preReg ? "warn" : "unknown"],
    ["Fee", policy.fee || "Not specified", policy.fee && policy.fee !== "No fee mentioned" ? "warn" : policy.fee === "No fee mentioned" ? "good" : "unknown"],
  ];

  if (policy.deposit) {
    rows.push(["Refundable deposit", policy.deposit, "warn"]);
  }

  for (const [label, value, tone] of rows) {
    c.appendChild(
      el(`<div class="row"><span class="label">${label}</span><span class="value tone-${tone}">${escapeHtml(value)}</span></div>`)
    );
  }

  if (policy.otherNotes && policy.otherNotes.length) {
    c.appendChild(el(`<p class="muted" style="margin-top:8px;">+ ${policy.otherNotes.length} other pet note(s) — see the on-page panel for details.</p>`));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function withActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    cb(tab);
  });
}

function isListingUrl(urlStr) {
  try {
    const u = new URL(urlStr);
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

function loadPolicy() {
  withActiveTab((tab) => {
    if (!tab || !tab.url || !isListingUrl(tab.url)) {
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
