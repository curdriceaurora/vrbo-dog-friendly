// test/site-adapters-airbnb.test.js
// Unit tests for the Airbnb site adapter (src/sites/airbnb/adapter.js).
//
// getPdpStructuredPayload() is exercised against real fixtures captured
// from 6 live listings (test/fixtures/airbnb/*.json) — manually saved
// per issue #12 ("no scripted live-crawl tooling for fixture capture";
// Airbnb runs DataDome). Deliberately not asserting exact corpus counts
// against every fixture: the walker is designed to be generic (walk
// broadly, let buildCorpus's keyword filter decide relevance) precisely
// because "we don't know what we don't know" about Airbnb's payload shape
// beyond these 6 samples — asserting brittle exact counts here would
// re-introduce the same narrowness the adapter itself avoids.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const adapter = require("../src/sites/airbnb/adapter.js");
const { airbnbSite } = adapter;
const extract = require("../src/shared/extract.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "airbnb");

function loadFixtureRaw(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

// Minimal document mock: the adapter only ever calls
// document.getElementById("data-deferred-state-0").textContent.
function withMockDocument(rawJsonText, fn) {
  const prevDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (id !== "data-deferred-state-0") return null;
      return { textContent: rawJsonText };
    },
  };
  try {
    return fn();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
}

describe("airbnb adapter: URL matching and property id extraction", () => {
  test("matchesHostname accepts airbnb.com and subdomains, rejects others", () => {
    assert.equal(airbnbSite.matchesHostname("www.airbnb.com"), true);
    assert.equal(airbnbSite.matchesHostname("airbnb.com"), true);
    assert.equal(airbnbSite.matchesHostname("es.airbnb.com"), true);
    assert.equal(airbnbSite.matchesHostname("www.vrbo.com"), false);
    assert.equal(airbnbSite.matchesHostname("airbnb.com.evil.com"), false);
    assert.equal(airbnbSite.matchesHostname(""), false);
    assert.equal(airbnbSite.matchesHostname(null), false);
  });

  test("isListingUrl matches /rooms/<id> only", () => {
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/rooms/42406610"), true);
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/rooms/1187760251755966099"), true);
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/rooms/42406610/"), true);
  });

  test("isListingUrl rejects the dead /rooms/plus/ route", () => {
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/rooms/plus/42406610"), false);
  });

  test("isListingUrl rejects search, profile, and help pages", () => {
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/s/San-Diego/homes"), false);
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/users/show/12345"), false);
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/help/article/1869"), false);
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/rooms/"), false);
    assert.equal(airbnbSite.isListingUrl("https://www.airbnb.com/rooms/abc"), false);
  });

  test("isSearchUrl always returns false — search-page badging is out of scope", () => {
    assert.equal(airbnbSite.isSearchUrl("https://www.airbnb.com/s/San-Diego/homes"), false);
    assert.equal(airbnbSite.isSearchUrl("https://www.airbnb.com/rooms/42406610"), false);
  });

  test("getPropertyId returns a string, never a number, for a typical 8-digit id", () => {
    const id = airbnbSite.getPropertyId("https://www.airbnb.com/rooms/42406610");
    assert.equal(typeof id, "string");
    assert.equal(id, "42406610");
  });

  test("getPropertyId stays a string end-to-end for ids past Number.MAX_SAFE_INTEGER", () => {
    // Real id observed on a live listing (Sunny 1 bed cottage fixture) —
    // 19 digits, well past 2^53-1. If this were ever coerced through
    // Number()/parseInt, precision would silently be lost.
    const url = "https://www.airbnb.com/rooms/1187760251755966099";
    const id = airbnbSite.getPropertyId(url);
    assert.equal(typeof id, "string");
    assert.equal(id, "1187760251755966099");
    assert.equal(id.length, 19);
    assert.ok(Number(id) > Number.MAX_SAFE_INTEGER, "sanity check: this id is actually past the unsafe-integer boundary");
    // The adapter's own cache key must also carry the id as a string.
    assert.equal(airbnbSite.getCacheKey(id), `vrbow_cache_airbnb_${id}`);
  });

  test("getPropertyId returns null for non-Airbnb or non-listing URLs", () => {
    assert.equal(airbnbSite.getPropertyId("https://www.vrbo.com/rooms/42406610"), null);
    assert.equal(airbnbSite.getPropertyId("https://www.airbnb.com/s/San-Diego/homes"), null);
  });

  test("isListingUrl/getPropertyId accept a relative path resolved against a baseUrl (the site-registry.js call convention)", () => {
    const baseUrl = "https://www.airbnb.com/";
    assert.equal(airbnbSite.isListingUrl("/rooms/42406610", baseUrl), true);
    assert.equal(airbnbSite.getPropertyId("/rooms/42406610", baseUrl), "42406610");
  });

  test("isListingUrl/getPropertyId fail closed (false/null, no throw) on a genuinely malformed URL", () => {
    assert.doesNotThrow(() => airbnbSite.isListingUrl("not a url at all"));
    assert.equal(airbnbSite.isListingUrl("not a url at all"), false);
    assert.equal(airbnbSite.getPropertyId("not a url at all"), null);
  });

  test("getCanonicalFetchUrl normalizes to the bare airbnb.com origin + path, and returns null off-site", () => {
    assert.equal(
      airbnbSite.getCanonicalFetchUrl("https://www.airbnb.com/rooms/42406610?check_in=2026-01-01"),
      "https://www.airbnb.com/rooms/42406610"
    );
    assert.equal(airbnbSite.getCanonicalFetchUrl("https://www.vrbo.com/123456"), null);
  });

  test("decorateFetchUrl is a passthrough today (no query-param decoration needed, unlike Vrbo's)", () => {
    const url = "https://www.airbnb.com/rooms/42406610?foo=bar";
    assert.equal(airbnbSite.decorateFetchUrl(url), url);
  });

  test("registering the adapter self-registers airbnbSite with the shared site registry", () => {
    // A fresh require of both modules, with VdpSiteRegistry populated
    // *before* the adapter loads — mirrors manifest.json's real script
    // order (site-registry.js, then sites/airbnb/adapter.js) — is needed
    // to actually exercise the self-registration branch; the module-level
    // require at the top of this file already ran with no registry
    // present, so re-requiring from cache wouldn't re-run that branch.
    delete require.cache[require.resolve("../src/sites/airbnb/adapter.js")];
    const savedRegistry = globalThis.VdpSiteRegistry;
    try {
      globalThis.VdpSiteRegistry = require("../src/shared/site-registry.js");
      require("../src/sites/airbnb/adapter.js");
      const registered = globalThis.VdpSiteRegistry.getSiteForHostname("www.airbnb.com");
      assert.ok(registered, "adapter.js did not self-register with VdpSiteRegistry on load");
      assert.equal(registered.id, "airbnb");
    } finally {
      globalThis.VdpSiteRegistry.unregisterSite?.("airbnb");
      globalThis.VdpSiteRegistry = savedRegistry;
      delete require.cache[require.resolve("../src/sites/airbnb/adapter.js")];
      require("../src/sites/airbnb/adapter.js"); // restore the module-level `adapter`/`airbnbSite` bindings used by every other test in this file
    }
  });
});

describe("airbnb adapter: getPdpStructuredPayload against real fixtures", () => {
  test("fails gracefully (returns null) when the script tag is missing", () => {
    globalThis.document = { getElementById: () => null };
    try {
      assert.equal(airbnbSite.getPdpStructuredPayload(), null);
    } finally {
      delete globalThis.document;
    }
  });

  test("fails gracefully (returns null, does not throw) on malformed JSON", () => {
    withMockDocument("{not valid json", () => {
      assert.doesNotThrow(() => airbnbSite.getPdpStructuredPayload());
      assert.equal(airbnbSite.getPdpStructuredPayload(), null);
    });
  });

  test("fails gracefully (returns null) when niobeClientData is missing or the wrong shape", () => {
    withMockDocument(JSON.stringify({ somethingElse: true }), () => {
      assert.equal(airbnbSite.getPdpStructuredPayload(), null);
    });
    withMockDocument(JSON.stringify({ niobeClientData: "not an array" }), () => {
      assert.equal(airbnbSite.getPdpStructuredPayload(), null);
    });
  });

  test("buried-fee fixture (Baywatch Retreat): the buried per-night/week/month pet fee text is present in the walked items", () => {
    const raw = loadFixtureRaw("buried-fee-baywatch.json");
    const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
    assert.ok(payload && Array.isArray(payload.items));
    const feeItem = payload.items.find((it) => /Pet Fee/i.test(it.text) && /\$40\/Night/i.test(it.text));
    assert.ok(feeItem, "expected the buried pet-fee text to appear as a walked item");
    assert.equal(typeof feeItem.text, "string");
  });

  test("WHAT_COUNTS_AS_A_PET boilerplate is excluded from every fixture, not just where it happens to appear", () => {
    const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const raw = loadFixtureRaw(file);
      const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
      assert.ok(payload && Array.isArray(payload.items), `${file}: expected a payload`);
      const poisoned = payload.items.find((it) => /service animals aren.t pets/i.test(it.text));
      assert.equal(poisoned, undefined, `${file}: WHAT_COUNTS_AS_A_PET boilerplate leaked into the corpus`);
    }
  });

  test("every real fixture parses without throwing and yields a non-empty item list", () => {
    const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 5, "expected at least the 5 fixtures captured for issue #12");
    for (const file of files) {
      const raw = loadFixtureRaw(file);
      const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
      assert.ok(payload, `${file}: expected a non-null payload`);
      assert.ok(payload.items.length > 0, `${file}: expected at least one walked item`);
      for (const item of payload.items) {
        assert.equal(typeof item.text, "string");
        assert.ok(item.text.length > 1, `${file}: unexpectedly short/empty item text`);
      }
    }
  });

  test("toggle-only fixtures still surface a 'Pets allowed' amenity/house-rule item", () => {
    for (const file of ["toggle-only-beautiful-2br.json", "toggle-only-nyc-studio.json", "toggle-only-upstay-resort.json"]) {
      const raw = loadFixtureRaw(file);
      const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
      const allowed = payload.items.find((it) => /^pets allowed$/i.test(it.text));
      assert.ok(allowed, `${file}: expected a "Pets allowed" item`);
    }
  });

  test("SEO/marketing link-farm text ('Pet-friendly vacation rentals in ...') is excluded, not just filtered downstream", () => {
    const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const raw = loadFixtureRaw(file);
      const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
      const seoNoise = payload.items.find((it) => /pet-friendly vacation rentals in/i.test(it.text));
      assert.equal(seoNoise, undefined, `${file}: seoLinks marketing copy leaked into the walked items`);
    }
  });

  test("the listing's own title/name does not appear as a duplicate item, but distinct real content with the same phrase does", () => {
    const raw = loadFixtureRaw("toggle-only-19digit-sunny-cottage.json");
    const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
    // Exact title match must be filtered out.
    const exactTitle = payload.items.find((it) => it.text === "Sunny 1 bed cottage a few blocks from dog beach!");
    assert.equal(exactTitle, undefined, "the listing's own title leaked into the walked items verbatim");
    // But real, distinct content that merely mentions similar words (this
    // fixture's actual "Dog Beach" neighborhood description) must survive —
    // this is a value-equality filter, not a keyword-based one.
    const realContent = payload.items.find((it) => /5-min walk to Dog Beach/i.test(it.text));
    assert.ok(realContent, "real neighborhood description text was incorrectly filtered along with the title");
  });
});

describe("airbnb adapter: end-to-end extraction (getPdpStructuredPayload -> buildCorpus -> extractPolicy)", () => {
  function extractFromFixture(file) {
    const raw = loadFixtureRaw(file);
    const payload = withMockDocument(raw, () => airbnbSite.getPdpStructuredPayload());
    const corpus = extract.buildCorpus(payload, []);
    return extract.extractPolicy(corpus);
  }

  test("buried-fee fixture (Baywatch Retreat) extracts a real per-night fee, not just the toggle", () => {
    const policy = extractFromFixture("buried-fee-baywatch.json");
    assert.equal(policy.petsAllowed, true);
    assert.ok(policy.fee, "expected a fee to be extracted from the buried 'Pet Fee: $40/Night' text");
    assert.match(policy.fee, /\$?40/);
  });

  test("buried-cap fixture (Upstay Resort) extracts a real dog-count cap and fee — found via the generic walk, not anticipated by the original issue research", () => {
    const policy = extractFromFixture("toggle-only-upstay-resort.json");
    assert.equal(policy.petsAllowed, true);
    assert.equal(policy.maxDogs, 2);
    assert.ok(policy.fee, "expected a per-pet fee to be extracted");
    assert.match(policy.fee, /\$?99/);
  });

  test("clean toggle-only fixtures produce zero otherNotes once SEO noise is excluded", () => {
    for (const file of ["toggle-only-beautiful-2br.json", "toggle-only-nyc-studio.json"]) {
      const policy = extractFromFixture(file);
      assert.equal(policy.petsAllowed, true);
      assert.deepEqual(policy.otherNotes, [], `${file}: expected no leftover notes once SEO-link noise is filtered`);
    }
  });

  test("host-pets edge case (Guesthouse) surfaces 'Pet(s) live on property' as an informational note, not a false structured field", () => {
    const policy = extractFromFixture("toggle-only-host-pets-guesthouse.json");
    assert.equal(policy.petsAllowed, true);
    // The host's own pets on the property must not be misread as a guest
    // weight/count restriction — it has no numeric content to extract.
    assert.equal(policy.maxDogs, null);
    assert.equal(policy.weightLimit, undefined);
    const note = policy.otherNotes.find((n) => /pet\(s\) live on property/i.test(n.text));
    assert.ok(note, "expected the host-pets disclosure to appear as an other-note, not silently dropped");
  });
});
