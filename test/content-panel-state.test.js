// test/content-panel-state.test.js
// Unit tests for content.js's sparseStateMessage() — the fully-sparse
// panel state decision (see #12's "Allowed, no additional restrictions
// listed" state), split out as a pure, DOM-free function specifically so
// it's testable without mocking document.createElement and the rest of
// renderPanel's DOM construction. The full render is covered end-to-end
// against the real extension in e2e/airbnb-listing.spec.js; this file
// covers just the wording/tone decision in isolation, fast and without a
// browser.
//
// content.js references document/window/chrome at module scope even
// though sparseStateMessage itself touches none of them, so a minimal
// stub environment is required just to require() the file — mirrors the
// (larger) setup in test/search-ui.test.js, trimmed to what's actually
// needed to load the module without hanging (setInterval in particular:
// content.js calls setInterval(onUrlMaybeChanged, 1000) at module scope,
// which would keep a real timer alive and the test process running
// forever if not stubbed).

const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");

let sparseStateMessage;

before(() => {
  globalThis.window = globalThis;
  globalThis.document = {
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    documentElement: { appendChild() {} },
    body: {},
    createTreeWalker() { return { nextNode() { return null; } }; },
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => {};
  globalThis.location = { href: "https://example.com/" };
  globalThis.chrome = {
    storage: { local: { get(_k, cb) { cb({}); }, set() {} }, onChanged: { addListener() {} } },
    runtime: { id: "mock-extension-id", onMessage: { addListener() {} } },
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init ? init.detail : undefined; } };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  // Prevents the module-scope setInterval(onUrlMaybeChanged, 1000) call
  // from keeping a real timer alive — this test process would otherwise
  // never exit.
  globalThis.setInterval = () => ({ mockInterval: true });
  globalThis.clearInterval = () => {};

  globalThis.VdpSiteRegistry = require("../src/shared/site-registry.js");
  globalThis.VDPExtract = require("../src/shared/extract.js");
  globalThis.VdpFormatters = require("../src/shared/formatters.js");

  ({ sparseStateMessage } = require("../src/content/content.js").__test);
});

describe("content.js: sparseStateMessage (fully-sparse panel state)", () => {
  test("petsAllowed === true: affirmative 'Allowed, no additional restrictions listed' wording with the good tone", () => {
    const { text, toneClass } = sparseStateMessage(true);
    assert.match(text, /^Allowed, no additional restrictions listed\./);
    assert.match(text, /Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing\.$/);
    assert.equal(toneClass, " vdp-tone-good");
  });

  test("petsAllowed === false: neutral 'weren't stated' wording, no tone class", () => {
    const { text, toneClass } = sparseStateMessage(false);
    assert.equal(text, "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.");
    assert.doesNotMatch(text, /^Allowed/);
    assert.equal(toneClass, "");
  });

  test("petsAllowed === null (genuinely unconfirmed): same neutral wording as false, not the affirmative one", () => {
    const { text, toneClass } = sparseStateMessage(null);
    assert.equal(text, "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.");
    assert.equal(toneClass, "");
  });

  test("petsAllowed === undefined: same neutral wording (only a strict === true is treated as confirmed-allowed)", () => {
    const { text, toneClass } = sparseStateMessage(undefined);
    assert.equal(text, "Max dogs, weight limit, fee, and pre-registration weren't stated anywhere on this listing.");
    assert.equal(toneClass, "");
  });

  test("the affirmative and neutral messages are genuinely distinct strings, not the same text with a class swapped in", () => {
    const allowed = sparseStateMessage(true);
    const unknown = sparseStateMessage(null);
    assert.notEqual(allowed.text, unknown.text);
  });
});
