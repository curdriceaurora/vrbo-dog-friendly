// test/site-registry.test.js
// Unit tests for shared/site-registry.js

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const siteRegistry = require("../src/shared/site-registry.js");

describe("site-registry: getSiteForHostname", () => {
  test("resolves vrbo site for standard and www hostnames (case-insensitive)", () => {
    const s1 = siteRegistry.getSiteForHostname("vrbo.com");
    assert.ok(s1);
    assert.equal(s1.id, "vrbo");

    const s2 = siteRegistry.getSiteForHostname("www.vrbo.com");
    assert.ok(s2);
    assert.equal(s2.id, "vrbo");

    const s3 = siteRegistry.getSiteForHostname("WWW.VRBO.COM");
    assert.ok(s3);
    assert.equal(s3.id, "vrbo");
  });

  test("returns null for non-vrbo hostnames", () => {
    assert.equal(siteRegistry.getSiteForHostname("airbnb.com"), null);
    assert.equal(siteRegistry.getSiteForHostname("google.com"), null);
    assert.equal(siteRegistry.getSiteForHostname("fakevrbo.com"), null);
    assert.equal(siteRegistry.getSiteForHostname("vrbo.fake.com"), null);
  });

  test("returns null for empty or non-string inputs", () => {
    assert.equal(siteRegistry.getSiteForHostname(""), null);
    assert.equal(siteRegistry.getSiteForHostname(null), null);
    assert.equal(siteRegistry.getSiteForHostname(undefined), null);
    assert.equal(siteRegistry.getSiteForHostname(123), null);
  });
});

describe("site-registry: getSiteForUrl", () => {
  test("resolves vrbo site from valid Vrbo URLs", () => {
    const s1 = siteRegistry.getSiteForUrl("https://www.vrbo.com/123456");
    assert.ok(s1);
    assert.equal(s1.id, "vrbo");

    const s2 = siteRegistry.getSiteForUrl("http://vrbo.com/Hotel-Search?destination=Miami");
    assert.ok(s2);
    assert.equal(s2.id, "vrbo");
  });

  test("returns null for non-vrbo URLs", () => {
    assert.equal(siteRegistry.getSiteForUrl("https://www.airbnb.com/rooms/123456"), null);
    assert.equal(siteRegistry.getSiteForUrl("https://www.google.com"), null);
  });

  test("returns null for invalid, empty, or non-string inputs", () => {
    assert.equal(siteRegistry.getSiteForUrl(""), null);
    assert.equal(siteRegistry.getSiteForUrl(null), null);
    assert.equal(siteRegistry.getSiteForUrl(undefined), null);
    assert.equal(siteRegistry.getSiteForUrl("not a valid url"), null);
    assert.equal(siteRegistry.getSiteForUrl(12345), null);
  });
});

describe("site-registry: Vrbo isListingUrl", () => {
  const vrbo = siteRegistry.getSiteForHostname("vrbo.com");
  assert.ok(vrbo);

  test("identifies standard numeric and alphanumeric listing paths", () => {
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/123456/"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/123456ha"), true);
    assert.equal(vrbo.isListingUrl("https://vrbo.com/987654321"), true);
  });

  test("identifies PDP listing paths", () => {
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/pdp/123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/pdp/lo/123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/pdp/123456a/"), true);
  });

  test("identifies vacation-rentals listing paths", () => {
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/vacation-rentals/123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/vacation-rentals/p123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/vacation-rentals/p/123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/vacation-rental/p123456"), true);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/vacation-rental/p/p123456/"), true);
  });

  test("rejects non-listing Vrbo pages", () => {
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/"), false);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/search?destination=Miami"), false);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/Hotel-Search"), false);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/about-us"), false);
    assert.equal(vrbo.isListingUrl("https://www.vrbo.com/help"), false);
  });

  test("rejects listing paths on non-Vrbo hostnames", () => {
    assert.equal(vrbo.isListingUrl("https://www.airbnb.com/123456"), false);
    assert.equal(vrbo.isListingUrl("https://fakevrbo.com/123456"), false);
  });

  test("supports relative paths against default or custom baseUrl", () => {
    assert.equal(vrbo.isListingUrl("/123456"), true);
    assert.equal(vrbo.isListingUrl("/pdp/123456"), true);
    assert.equal(vrbo.isListingUrl("/vacation-rentals/p123456"), true);
    assert.equal(vrbo.isListingUrl("/123456", "https://vrbo.com"), true);
    assert.equal(vrbo.isListingUrl("/123456", "https://airbnb.com"), false);
  });

  test("works when method is destructured from site entry (this-safety)", () => {
    const { isListingUrl } = vrbo;
    assert.equal(isListingUrl("https://www.vrbo.com/123456"), true);
    assert.equal(isListingUrl("https://www.vrbo.com/search"), false);
  });
});

describe("site-registry: Vrbo isSearchUrl", () => {
  const vrbo = siteRegistry.getSiteForHostname("vrbo.com");
  assert.ok(vrbo);

  test("identifies standard search, Hotel-Search, and vacation-rentals/search paths", () => {
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/search?destination=Miami"), true);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/Hotel-Search?destination=Miami"), true);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/hotel-search"), true);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/vacation-rentals/search?destination=Miami"), true);
  });

  test("identifies localized and sub-path search URLs", () => {
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/en-us/search"), true);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/d/12345/search"), true);
    assert.equal(vrbo.isSearchUrl("/search?destination=Miami"), true);
  });

  test("enforces keyword boundary precision against false positive suffixes", () => {
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/searchpage"), false);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/foo/searchbar"), false);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/hotel-search-villa"), false);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/search/results"), true);
  });

  test("rejects non-search pages and non-Vrbo hostnames", () => {
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/123456"), false);
    assert.equal(vrbo.isSearchUrl("https://www.vrbo.com/"), false);
    assert.equal(vrbo.isSearchUrl("https://www.airbnb.com/search"), false);
    assert.equal(vrbo.isSearchUrl("https://www.google.com/search"), false);
  });

  test("works when method is destructured from site entry (this-safety)", () => {
    const { isSearchUrl } = vrbo;
    assert.equal(isSearchUrl("https://www.vrbo.com/search"), true);
    assert.equal(isSearchUrl("https://www.vrbo.com/123456"), false);
  });

  test("handles null, malformed, or empty URLs cleanly without throwing", () => {
    assert.equal(vrbo.isSearchUrl(""), false);
    assert.equal(vrbo.isSearchUrl(null), false);
    assert.equal(vrbo.isSearchUrl(undefined), false);
    assert.equal(vrbo.isSearchUrl("not-a-url"), false);
  });
});

describe("site-registry: Vrbo getCanonicalFetchUrl", () => {
  const vrbo = siteRegistry.getSiteForHostname("vrbo.com");
  assert.ok(vrbo);

  test("constructs canonical HTTPS fetch URL without query parameters or hashes", () => {
    assert.equal(
      vrbo.getCanonicalFetchUrl("https://www.vrbo.com/123456?unitId=1&foo=bar#reviews"),
      "https://www.vrbo.com/123456"
    );
    assert.equal(
      vrbo.getCanonicalFetchUrl("https://vrbo.com/pdp/123456?tab=rules"),
      "https://www.vrbo.com/pdp/123456"
    );
    assert.equal(
      vrbo.getCanonicalFetchUrl("/vacation-rentals/p123456?avail=1"),
      "https://www.vrbo.com/vacation-rentals/p123456"
    );
  });

  test("returns null for non-Vrbo or invalid URLs", () => {
    assert.equal(vrbo.getCanonicalFetchUrl("https://airbnb.com/rooms/123"), null);
    assert.equal(vrbo.getCanonicalFetchUrl(""), null);
    assert.equal(vrbo.getCanonicalFetchUrl(null), null);
    assert.equal(vrbo.getCanonicalFetchUrl("not a url"), null);
  });

  test("registry getCanonicalFetchUrl delegates to site adapter and falls back generically", () => {
    assert.equal(
      siteRegistry.getCanonicalFetchUrl("https://www.vrbo.com/123456?q=1"),
      "https://www.vrbo.com/123456"
    );
    assert.equal(
      siteRegistry.getCanonicalFetchUrl("https://example.com/test?q=1"),
      "https://example.com/test"
    );
    assert.equal(siteRegistry.getCanonicalFetchUrl("bad-url"), null);
  });
});

describe("site-registry: Vrbo decorateFetchUrl", () => {
  const vrbo = siteRegistry.getSiteForHostname("vrbo.com");
  assert.ok(vrbo);

  test("appends locale=en_US and siteid=1 query parameters to Vrbo fetch URLs", () => {
    const res = vrbo.decorateFetchUrl("https://www.vrbo.com/123456");
    const u = new URL(res);
    assert.equal(u.searchParams.get("locale"), "en_US");
    assert.equal(u.searchParams.get("siteid"), "1");
  });

  test("registry decorateFetchUrl delegates to site adapter and preserves non-Vrbo URLs unchanged", () => {
    const vrboRes = siteRegistry.decorateFetchUrl("https://www.vrbo.com/123456");
    const vrboUrl = new URL(vrboRes);
    assert.equal(vrboUrl.searchParams.get("locale"), "en_US");
    assert.equal(vrboUrl.searchParams.get("siteid"), "1");

    const otherRes = siteRegistry.decorateFetchUrl("https://example.com/123456");
    assert.equal(otherRes, "https://example.com/123456");
  });
});

describe("site-registry: Vrbo getPropertyId tiered extraction", () => {
  const vrbo = siteRegistry.getSiteForHostname("vrbo.com");
  assert.ok(vrbo);

  test("extracts canonical property ID across all standard Vrbo URL forms", () => {
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/123456"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/p123456"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/pdp/123456"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/pdp/lo/123456"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/vacation-rentals/p123456"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/vacation-rentals/p/123456"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/vacation-rentals/p/p123456/"), "123456");
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/123456ha?unitId=10"), "123456ha");
  });

  test("supports relative paths for property ID extraction", () => {
    assert.equal(vrbo.getPropertyId("/123456"), "123456");
    assert.equal(vrbo.getPropertyId("/pdp/123456"), "123456");
    assert.equal(vrbo.getPropertyId("/vacation-rentals/p123456"), "123456");
  });

  test("works when getPropertyId is destructured (this-safety)", () => {
    const { getPropertyId } = vrbo;
    assert.equal(getPropertyId("https://www.vrbo.com/123456"), "123456");
  });

  test("returns null for non-listing or non-Vrbo URLs", () => {
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/search"), null);
    assert.equal(vrbo.getPropertyId("https://www.vrbo.com/"), null);
    assert.equal(vrbo.getPropertyId("https://www.airbnb.com/rooms/123456"), null);
    assert.equal(vrbo.getPropertyId(""), null);
    assert.equal(vrbo.getPropertyId(null), null);
    assert.equal(vrbo.getPropertyId(undefined), null);
    assert.equal(vrbo.getPropertyId("bad url"), null);
  });

  test("delegates to VDPExtract when available", () => {
    const origExtract = globalThis.VDPExtract;
    try {
      globalThis.VDPExtract = {
        extractPropertyId(url) {
          return url.includes("mock-extract") ? "mock-extract-id" : null;
        }
      };
      assert.equal(vrbo.getPropertyId("https://www.vrbo.com/mock-extract"), "mock-extract-id");
    } finally {
      globalThis.VDPExtract = origExtract;
    }
  });

  test("supports relative path without leading slash against baseUrl", () => {
    assert.equal(vrbo.isListingUrl("123456", "https://www.vrbo.com/"), true);
  });

  test("delegates to VdpExtract when VDPExtract is absent", () => {
    const origSearchFetcher = globalThis.VdpSearchFetcher;
    const origExtract = globalThis.VDPExtract;
    const origVdpExtract = globalThis.VdpExtract;
    try {
      delete globalThis.VdpSearchFetcher;
      delete globalThis.VDPExtract;
      globalThis.VdpExtract = {
        extractPropertyId(url) {
          return url.includes("mock-vdp") ? "mock-vdp-id" : null;
        }
      };
      assert.equal(vrbo.getPropertyId("https://www.vrbo.com/mock-vdp"), "mock-vdp-id");
    } finally {
      globalThis.VdpSearchFetcher = origSearchFetcher;
      globalThis.VDPExtract = origExtract;
      globalThis.VdpExtract = origVdpExtract;
    }
  });

  test("falls back to built-in regex extractor when extract modules are unavailable", () => {
    const origSearchFetcher = globalThis.VdpSearchFetcher;
    const origExtract = globalThis.VDPExtract;
    const origVdpExtract = globalThis.VdpExtract;
    try {
      delete globalThis.VdpSearchFetcher;
      delete globalThis.VDPExtract;
      delete globalThis.VdpExtract;

      const standaloneRegistry = siteRegistry.__factory(null);
      const v = standaloneRegistry.getSiteForHostname("vrbo.com");
      assert.equal(v.getPropertyId("https://www.vrbo.com/123456"), "123456");
      assert.equal(v.getPropertyId("https://www.vrbo.com/pdp/p9999"), "9999");
      assert.equal(v.getPropertyId("https://www.vrbo.com/search"), null);
    } finally {
      globalThis.VdpSearchFetcher = origSearchFetcher;
      globalThis.VDPExtract = origExtract;
      globalThis.VdpExtract = origVdpExtract;
    }
  });
});

describe("site-registry: site adapter capabilities & DOM selectors", () => {
  const vrbo = siteRegistry.getSiteForHostname("vrbo.com");
  assert.ok(vrbo);

  test("vrbo site adapter provides search card and content column selectors", () => {
    assert.ok(vrbo.searchCardSelector.includes("lodging-card-responsive"));
    assert.ok(Array.isArray(vrbo.cardContentSelector));
    assert.ok(vrbo.cardContentSelector.some((s) => s.includes("content")));
  });

  test("registry selector helpers resolve site-specific selectors with safe fallbacks", () => {
    assert.ok(siteRegistry.getSearchCardSelector("https://www.vrbo.com/search").includes("lodging-card-responsive"));
    assert.ok(siteRegistry.getSearchCardSelector("https://unknown-site.com/search").includes("property-card"));

    const vrboContentSelectors = siteRegistry.getCardContentSelector("https://www.vrbo.com/search");
    assert.ok(Array.isArray(vrboContentSelectors) || typeof vrboContentSelectors === "string");
    assert.ok(
      Array.isArray(vrboContentSelectors)
        ? vrboContentSelectors.some((s) => s.includes("content"))
        : vrboContentSelectors.includes("content")
    );
  });

  test("registry getCacheKey creates site-qualified cache keys", () => {
    assert.equal(siteRegistry.getCacheKey("https://www.vrbo.com/123456", "123456"), "vrbow_cache_123456");
    assert.equal(vrbo.getCacheKey("9999"), "vrbow_cache_9999");

    const customSite = {
      id: "airbnb",
      getCacheKey: (id) => `vrbow_cache_airbnb_${id}`,
    };
    assert.equal(siteRegistry.getCacheKey(customSite, "555"), "vrbow_cache_airbnb_555");
  });

  test("parseListingData delegates to site adapter or VDPExtract", () => {
    const origExtract = globalThis.VDPExtract;
    try {
      globalThis.VDPExtract = {
        extractListingData(html, url) {
          return { mockParsed: true, htmlLength: html.length, url };
        }
      };
      const res = siteRegistry.parseListingData("https://www.vrbo.com/123456", "<html>test</html>");
      assert.deepEqual(res, { mockParsed: true, htmlLength: 17, url: "https://www.vrbo.com/123456" });

      const customSite = {
        parseListingData(html, url) {
          return { custom: true, url };
        }
      };
      assert.deepEqual(siteRegistry.parseListingData(customSite, "<html></html>", "https://custom.com/1"), {
        custom: true,
        url: "https://custom.com/1",
      });
    } finally {
      globalThis.VDPExtract = origExtract;
    }
  });

  test("searchQueue storage engine consumes adapter getCacheKey and parseListingData end-to-end", async () => {
    const { createSearchFetchQueue } = require("../src/shared/search-fetcher.js");
    const mockStorage = {
      store: {},
      get(keys, cb) {
        const res = {};
        for (const k of keys) {
          if (this.store[k] !== undefined) res[k] = this.store[k];
        }
        cb(res);
      },
      set(items, cb) {
        Object.assign(this.store, items);
        if (cb) cb();
      },
      remove(keys, cb) {
        for (const k of keys) delete this.store[k];
        if (cb) cb();
      }
    };

    const mockFetch = async (url) => {
      return {
        ok: true,
        status: 200,
        url,
        text: async () => JSON.stringify({ customJson: true, petLimit: 2 })
      };
    };

    const customSite = {
      id: "airbnb",
      name: "Airbnb",
      matchesHostname: (h) => /airbnb\.com$/i.test(h),
      isListingUrl: (u) => /airbnb\.com\/rooms/i.test(u),
      isSearchUrl: (u) => /airbnb\.com\/s\//i.test(u),
      getPropertyId: (u) => {
        const m = /\/rooms\/([a-z0-9]+)/i.exec(u);
        return m ? m[1] : null;
      },
      getCanonicalFetchUrl: (u) => u,
      decorateFetchUrl: (u) => u,
      getCacheKey: (id) => `vrbow_cache_airbnb_${id}`,
      parseListingData: (html, url, propId) => {
        const data = JSON.parse(html);
        return {
          petsAllowed: true,
          maxDogs: data.petLimit,
          source: "custom-airbnb-parser",
          schemaVersion: 1
        };
      }
    };

    // Register custom site into registry
    siteRegistry.registerSite(customSite);

    try {
      const queue = createSearchFetchQueue({
        storage: mockStorage,
        fetchFn: mockFetch,
        minDelayMs: 10,
        sessionCap: 10,
      });

      // 1. Verify setCached generates site-qualified cache key
      const policyData = {
        status: "ok",
        propertyId: "room999",
        policy: {
          petsAllowed: true,
          maxDogs: 2,
          schemaVersion: 1
        }
      };

      await queue.setCached("room999", policyData, { targetUrl: "https://www.airbnb.com/rooms/room999" });
      assert.ok(
        mockStorage.store["vrbow_cache_airbnb_room999"],
        "queue engine must write under site-scoped cache key"
      );

      // 2. Verify getCached reads from site-qualified cache key
      const cached = await queue.getCached("room999", "https://www.airbnb.com/rooms/room999");
      assert.ok(cached);
      assert.equal(cached.propertyId, "room999");
      assert.equal(cached.policy.maxDogs, 2);

      // 3. Verify fetch pipeline dispatches through adapter parseListingData
      let dispatched = null;
      queue.subscribe("room888", (res) => {
        dispatched = res;
      });

      queue.enqueue("room888", "https://www.airbnb.com/rooms/room888", "high");
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(dispatched, "queue dispatched result");
      assert.equal(dispatched.status, "ok");
      assert.equal(dispatched.policy.maxDogs, 2);
      assert.equal(dispatched.policy.source, "custom-airbnb-parser");

      // Verify it was stored with the site's cache key
      assert.ok(
        mockStorage.store["vrbow_cache_airbnb_room888"],
        "dispatched item was cached under airbnb-scoped key"
      );

      queue.dispose();
    } finally {
      siteRegistry.unregisterSite("airbnb");
    }
  });
});
