const path = require("node:path");
const { chromium, expect, test } = require("@playwright/test");
const { installNetworkGuard } = require("./guardrail.js");

const EXTENSION_ROOT = path.join(__dirname, "..", "src");
const LISTING_URL = "https://www.airbnb.com/rooms/42406610";

// Minimal but structurally real payloads — same shape as the real captures
// in test/fixtures/airbnb/*.json (see test/site-adapters-airbnb.test.js for
// parsing correctness against those). This spec's job is different: prove
// the real extension, loaded via manifest.json, actually wires
// #data-deferred-state-0 -> the adapter -> content.js's scan() -> the
// rendered panel end to end — not re-verify extraction logic already
// covered by unit tests.
function pageHtml(niobeClientData) {
  const payload = JSON.stringify({ niobeClientData });
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Listing 42406610</title></head>
  <body>
    <script id="data-deferred-state-0" type="application/json">${payload}</script>
  </body>
</html>`;
}

function section(sectionComponentType, sectionBody) {
  return { sectionComponentType, section: sectionBody };
}

const TOGGLE_ONLY_PAYLOAD = [
  [
    "StaysPdpSections:{}",
    {
      data: {
        presentation: {
          stayProductDetailPage: {
            sections: {
              sections: [
                section("POLICIES_DEFAULT", {
                  __typename: "PoliciesSection",
                  houseRulesSections: [
                    {
                      __typename: "GeneralListContentSection",
                      title: "During your stay",
                      items: [{ __typename: "BasicListItem", title: "Pets allowed" }],
                    },
                  ],
                }),
                section("WHAT_COUNTS_AS_A_PET", {
                  __typename: "GeneralContentSection",
                  html: { __typename: "Html", htmlText: "Service animals aren’t pets, so there’s no need to add them here." },
                }),
              ],
            },
          },
        },
      },
      variables: {},
    },
  ],
];

const BURIED_FEE_PAYLOAD = [
  [
    "StaysPdpSections:{}",
    {
      data: {
        presentation: {
          stayProductDetailPage: {
            sections: {
              sections: [
                section("POLICIES_DEFAULT", {
                  __typename: "PoliciesSection",
                  houseRulesSections: [
                    {
                      __typename: "GeneralListContentSection",
                      title: "During your stay",
                      items: [{ __typename: "BasicListItem", title: "Pets allowed" }],
                    },
                  ],
                }),
                // Real buried-fee text lives under exactly this
                // typename/sectionComponentType combination on a live
                // listing (Baywatch Retreat, see #12 research) — not the
                // PoliciesSection the original issue anticipated.
                section("PDP_DESCRIPTION_MODAL", {
                  __typename: "GeneralListContentSection",
                  items: [
                    {
                      __typename: "BasicListItem",
                      html: { __typename: "Html", htmlText: "Pet's are considered (Pet Fee: $40/Night, $250/Wk, $300/Month)" },
                    },
                  ],
                }),
              ],
            },
          },
        },
      },
      variables: {},
    },
  ],
];

test.describe("Airbnb adapter: real extension end-to-end (issue #12)", () => {
  test("toggle-only listing renders the 'Allowed, no additional restrictions listed' state, not the generic unconfirmed one", async () => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_ROOT}`,
        `--load-extension=${EXTENSION_ROOT}`,
      ],
    });

    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);

      await page.route(`${LISTING_URL}*`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(TOGGLE_ONLY_PAYLOAD) })
      );

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel.locator(".vdp-title")).toHaveText("Dog policy");
      await expect(panel.locator(".vdp-header")).toHaveClass(/vdp-tone-good/);

      const sparseText = panel.locator(".vdp-unconfirmed-text");
      await expect(sparseText).toHaveText(/Allowed, no additional restrictions listed/);
      await expect(sparseText).toHaveClass(/vdp-tone-good/);

      // The generic "weren't stated" wording, unqualified by "Allowed",
      // must not also be present — this is the distinct branch, not a
      // superset of the existing unconfirmed one.
      await expect(panel).not.toContainText(/^Max dogs, weight limit/);

      // The WHAT_COUNTS_AS_A_PET boilerplate must not leak into the panel.
      await expect(panel).not.toContainText(/Service animals aren.t pets/);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });

  test("buried-fee listing renders real Max dogs / Fee rows, not the sparse state", async () => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_ROOT}`,
        `--load-extension=${EXTENSION_ROOT}`,
      ],
    });

    try {
      const page = await context.newPage();
      const guard = await installNetworkGuard(context, page);

      await page.route(`${LISTING_URL}*`, (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(BURIED_FEE_PAYLOAD) })
      );

      await page.goto(LISTING_URL);

      const panel = page.locator("#vdp-panel");
      await expect(panel).toBeVisible({ timeout: 6000 });
      await expect(panel).not.toContainText(/Allowed, no additional restrictions listed/);
      await expect(panel).toContainText(/Fee/);
      await expect(panel).toContainText(/\$40/);

      await guard.assertNoLeakedRequests(page);
    } finally {
      await context.close();
    }
  });
});
