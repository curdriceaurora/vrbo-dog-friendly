// test/site-adapters-expedia.test.js
// Unit tests for the Expedia site adapter (src/sites/expedia/adapter.js).

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const adapter = require("../src/sites/expedia/adapter.js");
const { expediaSite } = adapter;
const extract = require("../src/shared/extract.js");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "expedia");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

function allFixtureFiles() {
  return fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
}

function withMockDocument(fixture, fn, extraScripts = []) {
  const prevDocument = globalThis.document;
  const faqPage = fixture.faqPage && !fixture.faqPage["@type"]
    ? { "@type": "FAQPage", ...fixture.faqPage }
    : fixture.faqPage;
  const scripts = [faqPage, ...extraScripts].filter(Boolean).map((value) => ({
    textContent: typeof value === "string" ? value : JSON.stringify(value),
  }));
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === 'meta[itemprop="petsAllowed"]') {
        return (fixture.petsAllowedMeta || []).map((content) => ({
          content,
          getAttribute(name) {
            return name === "content" ? content : null;
          },
        }));
      }
      if (selector === 'script[type="application/ld+json"]') return scripts;
      return [];
    },
  };
  try {
    return fn();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
}

function loadPayload(file, extraScripts) {
  return withMockDocument(loadFixture(file), () => expediaSite.getPdpStructuredPayload(), extraScripts);
}

function normalizedPolicy(payload, propertyId = "expedia-test") {
  const corpus = extract.buildCorpus(payload, []);
  const raw = extract.extractPolicy(corpus);
  return extract.normalizePolicy(raw, propertyId, "listing-page");
}

describe("expedia adapter: URL matching and property id extraction", () => {
  test("matchesHostname accepts expedia.com and subdomains, rejects others", () => {
    assert.equal(expediaSite.matchesHostname("www.expedia.com"), true);
    assert.equal(expediaSite.matchesHostname("expedia.com"), true);
    assert.equal(expediaSite.matchesHostname("fr.expedia.com"), true);
    assert.equal(expediaSite.matchesHostname("www.vrbo.com"), false);
    assert.equal(expediaSite.matchesHostname("expedia.com.evil.com"), false);
    assert.equal(expediaSite.matchesHostname(""), false);
    assert.equal(expediaSite.matchesHostname(null), false);
  });

  test("isListingUrl matches the verified .h<id>.Hotel-Information route only", () => {
    const fixture = loadFixture("native-stayapt-suites.json");
    assert.equal(expediaSite.isListingUrl(fixture.url), true);
    assert.equal(expediaSite.isListingUrl(`${fixture.url}?chkin=2026-09-04`), true);
    assert.equal(expediaSite.isListingUrl("https://www.expedia.com/Pensacola-Hotels-Test.h12345.Hotel-Information/"), true);
    assert.equal(expediaSite.isListingUrl("https://www.expedia.com/Hotel-Search?destination=Pensacola"), false);
    assert.equal(expediaSite.isListingUrl("https://www.expedia.com/Flights"), false);
    assert.equal(expediaSite.isListingUrl("https://www.expedia.com/Cars"), false);
    assert.equal(expediaSite.isListingUrl("https://www.expedia.com/trips"), false);
    assert.equal(expediaSite.isListingUrl("https://www.expedia.com/Pensacola-Hotels-Test.habc.Hotel-Information"), false);
    assert.equal(expediaSite.isListingUrl("http://[bad"), false);
  });

  test("getPropertyId returns the h-id as a string and scopes cache keys", () => {
    const fixture = loadFixture("native-perdido-beach-bungalow.json");
    const id = expediaSite.getPropertyId(fixture.url);
    assert.equal(typeof id, "string");
    assert.equal(id, fixture.propertyId);
    assert.equal(expediaSite.getPropertyId("https://www.expedia.com/Hotel-Search?destination=Pensacola"), null);
    assert.equal(expediaSite.getCacheKey(id), `vrbow_cache_expedia_${id}`);
  });

  test("canonical fetch URL strips query strings and rejects off-site URLs", () => {
    assert.equal(
      expediaSite.getCanonicalFetchUrl("https://www.expedia.com/Foo-Hotels-Bar.h123.Hotel-Information?x=1#rooms"),
      "https://www.expedia.com/Foo-Hotels-Bar.h123.Hotel-Information"
    );
    assert.equal(expediaSite.getCanonicalFetchUrl("https://www.vrbo.com/123"), null);
    assert.equal(expediaSite.decorateFetchUrl("https://www.expedia.com/Foo.h123.Hotel-Information?x=1"), "https://www.expedia.com/Foo.h123.Hotel-Information?x=1");
  });

  test("isSearchUrl always returns false — Expedia search badging is out of scope", () => {
    assert.equal(expediaSite.isSearchUrl("https://www.expedia.com/Hotel-Search?destination=Pensacola"), false);
    assert.equal(expediaSite.isSearchUrl("https://www.expedia.com/Foo-Hotels-Bar.h123.Hotel-Information"), false);
  });

  test("registering the adapter self-registers expediaSite with the shared site registry", () => {
    delete require.cache[require.resolve("../src/sites/expedia/adapter.js")];
    const savedRegistry = globalThis.VdpSiteRegistry;
    try {
      globalThis.VdpSiteRegistry = require("../src/shared/site-registry.js");
      require("../src/sites/expedia/adapter.js");
      const registered = globalThis.VdpSiteRegistry.getSiteForHostname("www.expedia.com");
      assert.ok(registered, "adapter.js did not self-register with VdpSiteRegistry on load");
      assert.equal(registered.id, "expedia");
    } finally {
      globalThis.VdpSiteRegistry.unregisterSite?.("expedia");
      globalThis.VdpSiteRegistry = savedRegistry;
      delete require.cache[require.resolve("../src/sites/expedia/adapter.js")];
      require("../src/sites/expedia/adapter.js");
    }
  });

  test("browser content-script load attaches and registers the adapter", () => {
    const code = fs.readFileSync(path.join(__dirname, "..", "src", "sites", "expedia", "adapter.js"), "utf8");
    const context = {
      VdpSiteRegistry: {
        parseUrl: require("../src/shared/site-registry.js").parseUrl,
        registered: null,
        registerSite(site) {
          this.registered = site;
        },
      },
    };
    context.globalThis = context;
    vm.runInNewContext(code, context, { filename: "src/sites/expedia/adapter.js" });

    assert.ok(context.VdpExpediaAdapter);
    assert.equal(context.VdpSiteRegistry.registered.id, "expedia");
    assert.equal(context.VdpExpediaAdapter.expediaSite.getPropertyId("/Foo.h123.Hotel-Information"), "123");
  });
});

describe("expedia adapter: structured payload extraction", () => {
  test("returns null when document is unavailable or no sources are present", () => {
    const prevDocument = globalThis.document;
    try {
      delete globalThis.document;
      assert.equal(expediaSite.getPdpStructuredPayload(), null);
      globalThis.document = {};
      assert.equal(expediaSite.getPdpStructuredPayload(), null);
      globalThis.document = { querySelectorAll: () => [] };
      assert.equal(expediaSite.getPdpStructuredPayload(), null);
    } finally {
      if (prevDocument === undefined) delete globalThis.document;
      else globalThis.document = prevDocument;
    }
  });

  test("all captured fixtures surface explicit-context pet policy items", () => {
    for (const file of allFixtureFiles()) {
      const fixture = loadFixture(file);
      const payload = loadPayload(file);
      assert.ok(payload, `${file}: expected a payload`);
      assert.equal(
        payload.items.filter((it) => it.section === "Pet policy").length,
        fixture.petsAllowedMeta.length + fixture.faqPage.mainEntity.length
      );
      for (const item of payload.items) {
        assert.equal(item.header, "Pets");
        assert.equal(item.explicitPetContext, true);
      }
    }
  });

  test("JSON-LD question matching trims names and ignores unrelated pet/dog text", () => {
    const fixture = loadFixture("native-perdido-beach-bungalow.json");
    const noisyFaq = {
      "@type": "FAQPage",
      mainEntity: [
        {
          name: "Where is Perdido Beach Bungalow located?",
          acceptedAnswer: { text: "Near a Dog Beach attraction, but this is location copy." },
        },
        {
          name: "Is Perdido Beach Bungalow pet-friendly? ",
          acceptedAnswer: { text: "Yes, this property allows dogs (limit 2 total) with a maximum weight of up to 35 lbs per pet." },
        },
      ],
    };
    const payload = withMockDocument({ ...fixture, faqPage: noisyFaq }, () => expediaSite.getPdpStructuredPayload());
    assert.ok(payload.items.some((it) => /limit 2 total/i.test(it.text)), "expected the pet-friendly answer");
    assert.equal(payload.items.some((it) => /Dog Beach attraction/i.test(it.text)), false, "location FAQ text must not be included");
  });

  test("malformed or unrelated JSON-LD does not discard valid meta items", () => {
    const fixture = loadFixture("native-stayapt-suites.json");
    const payload = withMockDocument({ ...fixture, faqPage: { "@type": "ItemList" } }, () => expediaSite.getPdpStructuredPayload(), ["{not json"]);
    assert.ok(payload);
    assert.equal(payload.items.length, fixture.petsAllowedMeta.length);
    assert.ok(payload.items.some((it) => /Pets allowed for an extra charge/i.test(it.text)));
  });

  test("blank source values and non-FAQ JSON-LD shapes are ignored", () => {
    const payload = withMockDocument({
      petsAllowedMeta: ["   ", null],
      faqPage: {
        "@type": ["Thing", "FAQPage"],
        mainEntity: [
          { name: null, acceptedAnswer: { text: "Pets allowed" } },
          { name: "Is Test Hotel pet-friendly?", acceptedAnswer: {} },
          { name: "Is Test Hotel pet-friendly?", acceptedAnswer: { text: "Pets are welcome." } },
        ],
      },
    }, () => expediaSite.getPdpStructuredPayload(), [{ "@type": "FAQPage", mainEntity: null }]);
    assert.deepEqual(payload.items.map((it) => it.text), ["Pets are welcome."]);
  });
});

describe("expedia adapter: end-to-end policy extraction", () => {
  test("captured fixtures produce concrete policies with counts and weights", () => {
    const expectations = {
      "vrbo-sourced-beautiful-townhouse.json": { maxDogs: 1, weight: 50 },
      "vrbo-sourced-deck-views.json": { maxDogs: 2, weight: 50 },
      "native-perdido-beach-bungalow.json": { maxDogs: 2, weight: 35, fee: { amount: 87.55, period: "stay", perPet: true } },
      "vrbo-sourced-salty-sanctuary.json": { maxDogs: 2, weight: 20 },
      "native-stayapt-suites.json": { maxDogs: 2, weight: 75, fee: { amount: 25, period: "night", perPet: true } },
    };
    for (const [file, expected] of Object.entries(expectations)) {
      const policy = normalizedPolicy(loadPayload(file), loadFixture(file).propertyId);
      assert.equal(policy.petsAllowed, true, `${file}: pets should be allowed`);
      assert.equal(policy.maxDogs, expected.maxDogs, `${file}: maxDogs`);
      assert.equal(policy.weightLimit.value, expected.weight, `${file}: weight`);
      if (expected.fee) {
        assert.equal(policy.fee.amount, expected.fee.amount, `${file}: fee amount`);
        assert.equal(policy.fee.period, expected.fee.period, `${file}: fee period`);
        assert.equal(policy.fee.perPet, expected.fee.perPet, `${file}: per pet fee`);
      }
    }
  });

  test("comma-separated Expedia fee periods are retained", () => {
    const stay = normalizedPolicy({
      items: [{ header: "Pets", section: "Pet policy", text: "There's a fee of USD 87.55 per pet, per stay.", explicitPetContext: true }],
    });
    assert.deepEqual(stay.fee, { amount: 87.55, currency: "USD", period: "stay", perPet: true });

    const night = normalizedPolicy({
      items: [{ header: "Pets", section: "Pet policy", text: "There's a fee of USD 25 per pet, per night.", explicitPetContext: true }],
    });
    assert.deepEqual(night.fee, { amount: 25, currency: "USD", period: "night", perPet: true });
  });

  test("explicit no-pets microdata renders as prohibited, not unknown", () => {
    const policy = normalizedPolicy({
      items: [{ header: "Pets", section: "Pet policy", text: "No pets allowed", explicitPetContext: true }],
    });
    assert.equal(policy.petsAllowed, false);
  });
});
