// test/helpers/content-env-stub.js
// Shared primitives for stubbing the pieces of the browser environment that
// src/content/content.js touches at module scope, so it can be require()'d
// in Node without hanging or throwing.
//
// Both test/content-panel-state.test.js (a minimal load, just to reach
// sparseStateMessage()) and test/search-ui.test.js (a much richer harness
// with its own document/timer/storage mocks, purpose-built for
// intersection-observer/timer-precision search-orchestration testing) need
// this same narrow slice — CustomEvent/Event constructors, the
// setInterval/clearInterval no-op guard, and the three window-globals
// content.js expects manifest.json's real script-load order to have
// already put there.
//
// Deliberately NOT a full mockDocument/mockWindow here: search-ui.test.js's
// document/timer/storage mocks don't generalize to content-panel-state.test.js's
// needs (and vice versa) — unifying those would either bloat the simple
// load or dilute the fidelity the richer harness needs. This module covers
// only the part that was genuinely duplicated verbatim between the two.

class MockCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init ? init.detail : undefined;
  }
}

class MockEvent {
  constructor(type) {
    this.type = type;
  }
}

/**
 * Stubs setInterval/clearInterval as no-ops. content.js calls
 * setInterval(onUrlMaybeChanged, 1000) at module scope — without this, the
 * real timer keeps a live handle and the test process never exits.
 */
function installIntervalGuard() {
  globalThis.setInterval = () => ({ mockInterval: true });
  globalThis.clearInterval = () => {};
}

/**
 * Registers the three real shared modules as the window-globals content.js
 * expects to already be present (mirrors manifest.json's script-load
 * order: site-registry.js, extract.js, formatters.js, then content.js).
 */
function installVdpGlobals() {
  globalThis.VdpSiteRegistry = require("../../src/shared/site-registry.js");
  globalThis.VDPExtract = require("../../src/shared/extract.js");
  globalThis.VdpFormatters = require("../../src/shared/formatters.js");
}

module.exports = { MockCustomEvent, MockEvent, installIntervalGuard, installVdpGlobals };
