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

  test("delegates to VdpSearchFetcher when available", () => {
    const origSearchFetcher = globalThis.VdpSearchFetcher;
    try {
      globalThis.VdpSearchFetcher = {
        extractPropertyIdFromUrl(url) {
          return url.includes("mock") ? "mock-fetcher-id" : null;
        }
      };
      assert.equal(vrbo.getPropertyId("https://www.vrbo.com/mock"), "mock-fetcher-id");
    } finally {
      globalThis.VdpSearchFetcher = origSearchFetcher;
    }
  });

  test("delegates to VDPExtract when SearchFetcher is absent", () => {
    const origSearchFetcher = globalThis.VdpSearchFetcher;
    const origExtract = globalThis.VDPExtract;
    try {
      delete globalThis.VdpSearchFetcher;
      globalThis.VDPExtract = {
        extractPropertyId(url) {
          return url.includes("mock-extract") ? "mock-extract-id" : null;
        }
      };
      assert.equal(vrbo.getPropertyId("https://www.vrbo.com/mock-extract"), "mock-extract-id");
    } finally {
      globalThis.VdpSearchFetcher = origSearchFetcher;
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
