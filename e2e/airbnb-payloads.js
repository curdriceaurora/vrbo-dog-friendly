// e2e/airbnb-payloads.js
// Shared synthetic-but-structurally-real niobeClientData payload builders,
// used by both e2e/airbnb-listing.spec.js (real --load-extension end-to-end
// specs) and e2e/js-coverage.spec.js (browser-path coverage for
// src/sites/airbnb/adapter.js). Kept in one place instead of hand-inlining
// the same envelope/sections in each spec file — those were drifting even
// in wording (e.g. the WHAT_COUNTS_AS_A_PET boilerplate text) despite
// meaning the same thing.
//
// Small and synthetic deliberately: these specs' job is to prove real
// wiring (manifest -> adapter -> content.js -> rendered panel, or browser
// script-execution coverage), not to re-verify parsing correctness — that's
// already covered against the 6 real captured listings in
// test/site-adapters-airbnb.test.js and test/fixtures/airbnb/*.json.

function section(sectionComponentType, sectionBody) {
  return { sectionComponentType, section: sectionBody };
}

function buildNiobePayload(sections) {
  return [
    [
      "StaysPdpSections:{}",
      {
        data: {
          presentation: {
            stayProductDetailPage: {
              sections: { sections },
            },
          },
        },
        variables: {},
      },
    ],
  ];
}

// Real buried-fee text lives under exactly this typename/sectionComponentType
// combination on a live listing (Baywatch Retreat, see #12 research) — not
// the PoliciesSection the original issue anticipated.
const PETS_ALLOWED_SECTION = section("POLICIES_DEFAULT", {
  __typename: "PoliciesSection",
  houseRulesSections: [
    {
      __typename: "GeneralListContentSection",
      title: "During your stay",
      items: [{ __typename: "BasicListItem", title: "Pets allowed" }],
    },
  ],
});

const WHAT_COUNTS_AS_A_PET_SECTION = section("WHAT_COUNTS_AS_A_PET", {
  __typename: "GeneralContentSection",
  html: { __typename: "Html", htmlText: "Service animals aren’t pets, so there’s no need to add them here." },
});

function buriedFeeSection(htmlText) {
  return section("PDP_DESCRIPTION_MODAL", {
    __typename: "GeneralListContentSection",
    items: [{ __typename: "BasicListItem", html: { __typename: "Html", htmlText } }],
  });
}

const TOGGLE_ONLY_PAYLOAD = buildNiobePayload([PETS_ALLOWED_SECTION, WHAT_COUNTS_AS_A_PET_SECTION]);

const BURIED_FEE_PAYLOAD = buildNiobePayload([
  PETS_ALLOWED_SECTION,
  buriedFeeSection("Pet's are considered (Pet Fee: $40/Night, $250/Wk, $300/Month)"),
]);

module.exports = {
  section,
  buildNiobePayload,
  PETS_ALLOWED_SECTION,
  WHAT_COUNTS_AS_A_PET_SECTION,
  buriedFeeSection,
  TOGGLE_ONLY_PAYLOAD,
  BURIED_FEE_PAYLOAD,
};
