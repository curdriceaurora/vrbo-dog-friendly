// Fixture-based regression tests for the extraction layer.
//   node --test
//
// Each fixture is a sentence phrased the way a real host writes it. The
// point is to pin down the ambiguous cases — conditional restrictions
// that look like bans, "no pet fee" (friendly) vs "no pets" (not), and
// non-US units/currencies — so a future regex tweak can't quietly
// regress them.

const test = require("node:test");
const assert = require("node:assert");
const { extractPolicy, buildCorpus, normalizePolicy, deriveSearchBadge } = require("../extract.js");

// Runs one sentence through the extractor as if it came from a
// dedicated "Pets" row in the listing data.
function policyFor(...sentences) {
  return extractPolicy(sentences.map((text) => ({ text, source: "House Rules / Policies", priority: 5 })));
}

test("pets allowed / not allowed polarity", async (t) => {
  await t.test("detects a plain ban phrased with 'pets'", () => {
    assert.strictEqual(policyFor("No pets.").petsAllowed, false);
    assert.strictEqual(policyFor("Pets are not allowed.").petsAllowed, false);
    assert.strictEqual(policyFor("This is a pet-free home.").petsAllowed, false);
  });

  await t.test("detects a plain ban phrased with 'dogs'", () => {
    assert.strictEqual(policyFor("No dogs.").petsAllowed, false);
    assert.strictEqual(policyFor("No dogs allowed.").petsAllowed, false);
    assert.strictEqual(policyFor("Dogs are not permitted.").petsAllowed, false);
  });

  await t.test("detects a welcome phrased with 'dogs'", () => {
    assert.strictEqual(policyFor("Dogs are allowed.").petsAllowed, true);
    assert.strictEqual(policyFor("Dogs welcome!").petsAllowed, true);
    assert.strictEqual(policyFor("Dogs OK.").petsAllowed, true);
    assert.strictEqual(policyFor("This home is dog-friendly.").petsAllowed, true);
  });

  await t.test("a conditional restriction is not a ban", () => {
    assert.notStrictEqual(policyFor("No pets over 30 lbs.").petsAllowed, false);
    assert.notStrictEqual(policyFor("No dogs over 30 lbs.").petsAllowed, false);
    assert.notStrictEqual(policyFor("No pets without prior approval.").petsAllowed, false);
    assert.notStrictEqual(policyFor("No dogs unless approved by the host.").petsAllowed, false);
  });

  await t.test("'no pet fee' is a friendly statement, not a ban", () => {
    // Regression: this matched the ban pattern and rendered
    // "Pets are not allowed" on a free, dog-welcoming listing.
    const p = policyFor("There is no pet fee.");
    assert.notStrictEqual(p.petsAllowed, false);
    assert.strictEqual(p.noFeeMentioned, true);
    assert.strictEqual(p.fee, "No fee mentioned");

    assert.notStrictEqual(policyFor("No dog fee!").petsAllowed, false);
    assert.notStrictEqual(policyFor("No pet deposit required.").petsAllowed, false);
    assert.notStrictEqual(policyFor("No additional pet charges.").petsAllowed, false);
  });

  await t.test("a ban wins over a welcome in the same corpus", () => {
    assert.strictEqual(policyFor("No dogs allowed.", "Dogs welcome.").petsAllowed, false);
  });
});

test("max dogs", async (t) => {
  await t.test("numeric and written-word counts", () => {
    assert.strictEqual(policyFor("Up to 2 dogs are allowed.").maxDogs, 2);
    assert.strictEqual(policyFor("Maximum of three dogs.").maxDogs, 3);
    assert.strictEqual(policyFor("No more than 1 pet.").maxDogs, 1);
  });

  await t.test("trailing-qualifier phrasing", () => {
    assert.strictEqual(policyFor("2 dogs welcome.").maxDogs, 2);
    assert.strictEqual(policyFor("2 dogs max.").maxDogs, 2);
    assert.strictEqual(policyFor("two dogs total").maxDogs, 2);
  });

  // Both observed live on vrbo.com/3550839 and /5092427.
  await t.test("count separated from its allowance word by a weight clause", () => {
    assert.strictEqual(policyFor("Two Dogs up to 50lbs welcome, (non-refundable dog fees apply).").maxDogs, 2);
  });

  await t.test("count stated without repeating the noun", () => {
    assert.strictEqual(policyFor("Pets allowed: dogs (limit 2 total)").maxDogs, 2);
  });

  await t.test("a bare count near an unrelated word is not a dog count", () => {
    assert.strictEqual(policyFor("Dogs are great. The home sleeps 8 guests comfortably.").maxDogs, null);
  });
});

test("HTML in Apollo text", async (t) => {
  // The About blob arrives as raw HTML whose only separator is <br>.
  const blob =
    "Escape to the beach!<br><br>Two Dogs up to 50lbs welcome, (non-refundable dog fees apply; pre-registration is required).<br><br>" +
    "Private pool and elevator. ".repeat(20);

  await t.test("<br> is treated as a sentence break, not swallowed by the length cap", () => {
    const p = extractPolicy([{ text: blob, source: "About this property", priority: 3 }]);
    assert.strictEqual(p.maxDogs, 2);
    assert.strictEqual(p.weightPerDog, "50 lbs");
    assert.strictEqual(p.preReg, true);
  });

  await t.test("no raw markup reaches the rendered notes", () => {
    const p = extractPolicy([{ text: "Dog Friendly | Private Pool<br><br>Escape to Nautilus.", source: "About this property", priority: 3 }]);
    assert.ok(!p.otherNotes.some((n) => /<br|<\/?[a-z]+>/i.test(n.text)), "found markup in notes: " + JSON.stringify(p.otherNotes));
  });
});

test("weight limit", async (t) => {
  await t.test("imperial units", () => {
    assert.strictEqual(policyFor("Dogs up to 50 lbs.").weightPerDog, "50 lbs");
    assert.strictEqual(policyFor("Weight limit of 40 pounds.").weightPerDog, "40 lbs");
    assert.strictEqual(policyFor("25 lbs per dog.").weightPerDog, "25 lbs");
  });

  // Only the UNITS are localized here, not the surrounding phrasing —
  // every lead-in ("up to", "weight limit of") is still English, so this
  // covers stayz.com.au / bookabach.co.nz, not German or French prose.
  await t.test("metric units", () => {
    assert.strictEqual(policyFor("Dogs up to 20 kg.").weightPerDog, "20 kg");
    assert.strictEqual(policyFor("Weight limit of 15 kilos.").weightPerDog, "15 kg");
    assert.strictEqual(policyFor("Dogs up to 10 kilograms.").weightPerDog, "10 kg");
  });

  await t.test("a real disagreement is flagged", () => {
    const p = policyFor("Dogs up to 50 lbs.", "Weight limit of 75 pounds.");
    assert.strictEqual(p.weightPerDog, "50 lbs");
    assert.deepStrictEqual(
      p.weightAlternates.map((a) => a.value),
      ["75 lbs"]
    );
  });

  await t.test("the same limit restated in the other unit is not a disagreement", () => {
    const p = policyFor("Dogs up to 50 lbs.", "Weight limit of 23 kg.");
    assert.strictEqual(p.weightPerDog, "50 lbs");
    assert.deepStrictEqual(p.weightAlternates, []);
  });
});

test("fees and deposits", async (t) => {
  await t.test("dollar amounts, prefix and suffix phrasing", () => {
    assert.strictEqual(policyFor("There is a $75 pet fee.").fee, "$75");
    assert.strictEqual(policyFor("Pet fee of $75.").fee, "$75");
    assert.strictEqual(policyFor("$25 per night.").fee, "$25 per night");
    assert.strictEqual(policyFor("$25 per dog per night.").fee, "$25 per pet per night");
    assert.strictEqual(policyFor("$25 per dog per day.").fee, "$25 per pet per day");
    assert.strictEqual(policyFor("$25 per pet per day.").fee, "$25 per pet per day");
    assert.strictEqual(policyFor("Pet fee of $30 per day.").fee, "$30 per day");
    assert.strictEqual(policyFor("A $150 pet fee per stay.").fee, "$150 per stay");
    assert.strictEqual(policyFor("A $150 pet fee per stay for maximum allowed pets.").fee, "$150 per stay");
    assert.strictEqual(policyFor("$100 per stay for up to 2 dogs.").fee, "$100 per stay");
    assert.strictEqual(policyFor("$50 per pet.").fee, "$50 per pet");
  });

  await t.test("8.1.8 fee-period canonical contract preserves 'day' without converting to 'night'", () => {
    // 1. Per day
    const dayPolicy = normalizePolicy(policyFor("Pet fee of $25 per day."));
    assert.deepEqual(dayPolicy.fee, { amount: 25, currency: "USD", period: "day" });
    assert.notEqual(dayPolicy.fee.period, "night", "'day' must never silently convert to 'night'");

    // 2. Per pet per day
    const perPetDayPolicy = normalizePolicy(policyFor("Pet fee of $25 per pet per day."));
    assert.deepEqual(perPetDayPolicy.fee, { amount: 25, currency: "USD", period: "day", perPet: true });

    // 3. Per dog per day
    const perDogDayPolicy = normalizePolicy(policyFor("$30 per dog per day."));
    assert.deepEqual(perDogDayPolicy.fee, { amount: 30, currency: "USD", period: "day", perPet: true });

    // 4. Per stay for maximum allowed pets
    const maxPetsStayPolicy = normalizePolicy(policyFor("A $150 pet fee per stay for maximum allowed pets."));
    assert.deepEqual(maxPetsStayPolicy.fee, { amount: 150, currency: "USD", period: "stay" });

    // 5. Per stay for up to 2 dogs
    const upToDogsStayPolicy = normalizePolicy(policyFor("$100 per stay for up to 2 dogs."));
    assert.deepEqual(upToDogsStayPolicy.fee, { amount: 100, currency: "USD", period: "stay" });

    // 6. Per night
    const nightPolicy = normalizePolicy(policyFor("Pet fee of $25 per night."));
    assert.deepEqual(nightPolicy.fee, { amount: 25, currency: "USD", period: "night" });

    // 7. Per pet
    const petPolicy = normalizePolicy(policyFor("Pet fee of $50 per pet."));
    assert.deepEqual(petPolicy.fee, { amount: 50, currency: "USD", period: "pet", perPet: true });

    // 8. Bare fee (unknown period)
    const barePolicy = normalizePolicy(policyFor("There is a $75 pet fee."));
    assert.deepEqual(barePolicy.fee, { amount: 75, currency: "USD", period: "unknown" });
  });

  await t.test("non-USD currencies", () => {
    assert.strictEqual(policyFor("Pet fee of €50.").fee, "€50");
    assert.strictEqual(policyFor("50 € pet fee.").fee, "€50");
    assert.strictEqual(policyFor("A £30 dog fee applies.").fee, "£30");
    assert.strictEqual(policyFor("AU$40 pet fee.").fee, "AU$40");
    assert.strictEqual(policyFor("Dog fee: 60,00 EUR").fee, "€60.00");

    // Test canonical normalization
    const canonicalAud = normalizePolicy(policyFor("AU$40 pet fee."));
    assert.equal(canonicalAud.fee.currency, "AUD");
    assert.equal(canonicalAud.fee.amount, 40);

    const canonicalUsd = normalizePolicy(policyFor("US$25 pet fee."));
    assert.equal(canonicalUsd.fee.currency, "USD");
    assert.equal(canonicalUsd.fee.amount, 25);
  });

  await t.test("fractional weight preservation and badge derivation", () => {
    const raw = { petsAllowed: true, weightPerDog: "22.5 kg" };
    const canonical = normalizePolicy(raw);
    assert.equal(canonical.weightLimit.value, 22.5);
    assert.equal(canonical.weightLimit.unit, "kg");

    const badge = deriveSearchBadge(canonical);
    assert.equal(badge.text, "Dogs allowed · 22.5 kg", "Must not round 22.5 kg up to 23 kg");
  });

  await t.test("fee language synonyms normalize to identical canonical representations", () => {
    const synonyms = [
      "A $25 per pet per night fee applies.",
      "A $25 each pet per night fee applies.",
      "A $25 per each pet per night fee applies.",
      "A $25 each dog per night fee applies.",
      "A $25 per each dog per night fee applies.",
    ];

    for (const phrase of synonyms) {
      const extracted = extractPolicy([{ text: phrase, source: "House Rules", priority: 1 }]);
      assert.ok(extracted.fee, `Failed to extract fee from: "${phrase}"`);
      const canonical = normalizePolicy(extracted);
      assert.deepStrictEqual(
        canonical.fee,
        { amount: 25, currency: "USD", period: "night", perPet: true },
        `Synonym "${phrase}" did not produce expected canonical model`
      );
    }
  });

  await t.test("deriveSearchBadge returns restrictions warning status for approvalRequired and restrictionsFound", () => {
    // 1. Approval-required only (no affirmative petsAllowed)
    const approvalPolicy = { petsAllowed: null, approvalRequired: true };
    const approvalBadge = deriveSearchBadge(approvalPolicy);
    assert.equal(approvalBadge.statusKey, "restrictions");
    assert.equal(approvalBadge.className, "vdp-search-badge vdp-badge-restrictions");
    assert.equal(approvalBadge.text, "Pet restrictions · Approval required");

    // 2. Restrictions found only (no affirmative petsAllowed)
    const restrictionsPolicy = { petsAllowed: null, restrictionsFound: true };
    const restrictionsBadge = deriveSearchBadge(restrictionsPolicy);
    assert.equal(restrictionsBadge.statusKey, "restrictions");
    assert.equal(restrictionsBadge.className, "vdp-search-badge vdp-badge-restrictions");
    assert.equal(restrictionsBadge.text, "Pet restrictions");

    // 3. Weight limit only (no affirmative petsAllowed)
    const weightOnlyPolicy = { petsAllowed: null, weightLimit: { value: 50, unit: "lb", pounds: 50 } };
    const weightBadge = deriveSearchBadge(weightOnlyPolicy);
    assert.equal(weightBadge.statusKey, "restrictions");
    assert.equal(weightBadge.className, "vdp-search-badge vdp-badge-restrictions");
    assert.equal(weightBadge.text, "Pet restrictions · 50 lbs");

    // 4. Fee only (no affirmative petsAllowed)
    const feeOnlyPolicy = { petsAllowed: null, fee: { amount: 50, currency: "USD", period: "stay" } };
    const feeBadge = deriveSearchBadge(feeOnlyPolicy);
    assert.equal(feeBadge.statusKey, "restrictions");
    assert.equal(feeBadge.className, "vdp-search-badge vdp-badge-restrictions");
    assert.equal(feeBadge.text, "Pet restrictions · $50/stay");

    // 5. Max dogs only (no affirmative petsAllowed)
    const maxDogsOnlyPolicy = { petsAllowed: null, maxDogs: 2 };
    const maxDogsBadge = deriveSearchBadge(maxDogsOnlyPolicy);
    assert.equal(maxDogsBadge.statusKey, "restrictions");
    assert.equal(maxDogsBadge.className, "vdp-search-badge vdp-badge-restrictions");
    assert.equal(maxDogsBadge.text, "Pet restrictions · Max 2");

    // 6. Restriction note count only (no affirmative petsAllowed)
    const noteCountPolicy = { petsAllowed: null, restrictionNoteCount: 1 };
    const noteCountBadge = deriveSearchBadge(noteCountPolicy);
    assert.equal(noteCountBadge.statusKey, "restrictions");
    assert.equal(noteCountBadge.className, "vdp-search-badge vdp-badge-restrictions");
    assert.equal(noteCountBadge.text, "Pet restrictions");
  });

  await t.test("deposit is separate from fee", () => {
    const p = policyFor("A $75 pet fee applies.", "Refundable pet deposit of $200.");
    assert.strictEqual(p.fee, "$75");
    assert.strictEqual(p.deposit, "$200");
  });

  await t.test("compact badge budget: enforces status + at most two secondary constraints", () => {
    const raw = policyFor(
      "Up to 2 dogs are welcome.",
      "A $150 pet fee applies per stay.",
      "Dogs must weigh under 50 lbs.",
      "Refundable pet deposit of $200."
    );

    assert.strictEqual(raw.petsAllowed, true);
    assert.strictEqual(raw.maxDogs, 2);
    assert.strictEqual(raw.fee, "$150 per stay");
    assert.strictEqual(raw.weightPerDog, "50 lbs");
    assert.strictEqual(raw.deposit, "$200");

    const canonical = normalizePolicy(raw);
    assert.strictEqual(canonical.maxDogs, 2);
    assert.deepStrictEqual(canonical.fee, { amount: 150, currency: "USD", period: "stay" });
    assert.strictEqual(canonical.fee.perPet, undefined, "Stay-level fee without per-pet qualifier is stay-wide");
    assert.deepStrictEqual(canonical.weightLimit, { value: 50, unit: "lb", pounds: 50 });
    assert.deepStrictEqual(canonical.deposit, { amount: 200, currency: "USD" });

    const badge = deriveSearchBadge(canonical);
    assert.strictEqual(badge.statusKey, "allowed");
    assert.strictEqual(badge.text, "Max 2 dogs allowed · 50 lbs · $150/stay");
    assert.ok(badge.text.length < 60, `Badge text "${badge.text}" exceeds compact length budget`);

    // Verify 1 dog grammar
    const singleDogBadge = deriveSearchBadge({ petsAllowed: true, maxDogs: 1 });
    assert.strictEqual(singleDogBadge.text, "Max 1 dog allowed");

    // Verify 3 dogs grammar
    const threeDogsBadge = deriveSearchBadge({ petsAllowed: true, maxDogs: 3 });
    assert.strictEqual(threeDogsBadge.text, "Max 3 dogs allowed");
  });

  await t.test("conflicting fees are flagged", () => {
    const p = policyFor("There is a $75 pet fee.", "Pet fee of $100.");
    assert.strictEqual(p.fee, "$75");
    assert.deepStrictEqual(
      p.feeAlternates.map((a) => a.value),
      ["$100"]
    );
  });
});

test("pre-registration", () => {
  assert.strictEqual(policyFor("Dogs must be pre-registered with the host.").preReg, true);
  assert.strictEqual(policyFor("Please notify the host before arrival.").preReg, true);
  assert.strictEqual(policyFor("Prior approval required for pets.").preReg, true);
  assert.strictEqual(policyFor("Pets must be declared and the pet fee paid.").preReg, true);
  assert.strictEqual(policyFor("Pets must be declared and the pet fee paid.").fee, "Pet fee applies");
  assert.strictEqual(policyFor("There is a one time pet fee.").fee, "Pet fee applies");
  assert.strictEqual(policyFor("Just include pets when telling us how many family members or friends.").preReg, true);
  assert.strictEqual(policyFor("Dogs up to 50 lbs.").preReg, null);
});

test("unmatched pet sentences fall through to other notes", () => {
  const p = policyFor("No aggressive breeds or pit bulls.", "Dogs must be crated when left unattended.");
  assert.strictEqual(p.otherNotes.length, 2);
  assert.match(p.otherNotes[0].text, /aggressive breeds/);
});

test("buildCorpus", async (t) => {
  const payload = {
    items: [
      { header: "Pets", section: "House Rules / Policies", text: "No aggressive breeds." },
      { header: "Description", section: "About this property", text: "Bring your dog! Up to 2 dogs." },
      { header: "Kitchen", section: "Amenities", text: "Dishwasher and oven." },
    ],
  };

  await t.test("keeps non-keyword sentences under a dedicated Pets header", () => {
    const entries = buildCorpus(payload, []);
    assert.ok(entries.some((e) => e.text === "No aggressive breeds."));
  });

  await t.test("drops unrelated sentences from mixed-topic sections", () => {
    const entries = buildCorpus(payload, []);
    assert.ok(!entries.some((e) => /Dishwasher/.test(e.text)));
  });

  await t.test("sorts the dedicated Pets row above visible page text", () => {
    const entries = buildCorpus(payload, ["Dogs allowed per the page."]);
    assert.strictEqual(entries[0].text, "No aggressive breeds.");
    assert.strictEqual(entries[entries.length - 1].source, "Visible page text");
  });

  await t.test("drops a value that merely repeats its own section label", () => {
    // Every live listing sampled emitted a bare "Pets" string under the
    // "Pets" header, which surfaced as a contentless note.
    const entries = buildCorpus({ items: [{ header: "Pets", section: "Property amenities", text: "Pets" }] }, []);
    assert.deepStrictEqual(entries, []);
  });

  await t.test("de-dupes identical text, keeping the higher-priority source", () => {
    const entries = buildCorpus(payload, ["No aggressive breeds."]);
    const matches = entries.filter((e) => e.text === "No aggressive breeds.");
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].source, "House Rules / Policies > Pets");
  });

  await t.test("preserves specific section names for section-tagged DOM items", () => {
    const entries = buildCorpus(payload, [
      { text: "Only pets under 20 lbs allowed per contract.", source: "Guest reviews" },
    ]);
    const reviewEntry = entries.find((e) => /under 20 lbs/.test(e.text));
    assert.ok(reviewEntry);
    assert.strictEqual(reviewEntry.source, "Guest reviews");
  });

  await t.test("parses tiered pet fee and does not mistake 'One dog allowed for free' as Max dogs: 1", () => {
    const raw = policyFor("One dog is allowed at no additional cost, each subsequent dog is $25 each per stay.");
    assert.strictEqual(raw.petsAllowed, true);
    assert.strictEqual(raw.maxDogs, null, "Must not set maxDogs: 1 when sentence mentions subsequent dogs");
    assert.strictEqual(raw.fee, "$0 1st dog, $25 each subsequent dog per stay");

    const canonical = normalizePolicy(raw);
    assert.strictEqual(canonical.maxDogs, null);
    assert.strictEqual(canonical.fee.amount, 25);
    assert.strictEqual(canonical.fee.currency, "USD");
    assert.strictEqual(canonical.fee.period, "stay");
    assert.strictEqual(canonical.fee.perPet, true);
    assert.strictEqual(canonical.fee.tiered, true);

    const badge = deriveSearchBadge(canonical);
    assert.strictEqual(badge.text, "Dogs allowed · 1st free · $25/add'l/stay");
    assert.ok(badge.text.length < 60, `Badge text (${badge.text.length} chars) must be under 60 chars`);
  });

  await t.test("tiered fee badge stays within 60 char budget even with weight limit and approval required", () => {
    const canonical = {
      petsAllowed: true,
      maxDogs: null,
      weightLimit: { value: 50, unit: "lb", pounds: 50 },
      fee: { amount: 25, currency: "USD", period: "night", tiered: true },
      approvalRequired: true,
    };
    const badge = deriveSearchBadge(canonical);
    assert.strictEqual(badge.text, "Dogs allowed · 50 lbs · 1st free · $25/add'l/night");
    assert.ok(badge.text.length < 60, `Badge text (${badge.text.length} chars) must be under 60 chars`);
  });

  await t.test("retains legitimate max-dog limits in sentences with additional/extra pets clauses", () => {
    assert.strictEqual(policyFor("We allow up to 2 dogs; each additional dog is $25 per night.").maxDogs, 2);
    assert.strictEqual(policyFor("A maximum of 2 dogs is allowed; extra dogs are not permitted.").maxDogs, 2);
    assert.strictEqual(policyFor("Maximum of 2 dogs, additional dogs by request only.").maxDogs, 2);
    assert.strictEqual(policyFor("Up to 3 dogs welcome, no additional pets beyond that.").maxDogs, 3);
  });

  await t.test("parses plural tiered fee phrasing (are free, additional pets are $15)", () => {
    const raw = policyFor("First pet is free, additional pets are $15 each per night.");
    assert.strictEqual(raw.petsAllowed, true);
    assert.strictEqual(raw.maxDogs, null);
    assert.strictEqual(raw.fee, "$0 1st dog, $15 each subsequent dog per night");

    const canonical = normalizePolicy(raw);
    assert.strictEqual(canonical.fee.amount, 15);
    assert.strictEqual(canonical.fee.period, "night");
    assert.strictEqual(canonical.fee.tiered, true);
  });

  await t.test("decodes HTML entities (&nbsp;, &le;, &amp;) in raw text", () => {
    const raw = policyFor("Max&nbsp;2&nbsp;dogs allowed, weight&nbsp;&le;&nbsp;50&nbsp;lbs &amp; $150&nbsp;pet&nbsp;fee.");
    assert.strictEqual(raw.petsAllowed, true);
    assert.strictEqual(raw.maxDogs, 2);
    assert.strictEqual(raw.weightPerDog, "50 lbs");
    assert.strictEqual(raw.fee, "$150");
  });

  await t.test("extracts bare fee, weight, and count under explicit pet context", () => {
    const raw = extractPolicy([
      { text: "$150", source: "House Rules / Pets", priority: 5, isDedicatedPetsHeader: true },
      { text: "50 lbs", source: "House Rules / Pets", priority: 5, isDedicatedPetsHeader: true },
      { text: "2", source: "House Rules / Pets", priority: 5, isDedicatedPetsHeader: true },
    ]);
    assert.strictEqual(raw.fee, "$150");
    assert.strictEqual(raw.weightPerDog, "50 lbs");
    assert.strictEqual(raw.maxDogs, 2);
  });

  await t.test("extracts active verb allowances and additional fee phrasing in freeform prose", () => {
    const raw1 = policyFor("This property allows 1 dog with an additional fee of $500.");
    assert.strictEqual(raw1.petsAllowed, true);
    assert.strictEqual(raw1.maxDogs, 1);
    assert.strictEqual(raw1.fee, "$500");

    const badge1 = deriveSearchBadge(normalizePolicy(raw1));
    assert.strictEqual(badge1.text, "Max 1 dog allowed · $500 pet fee");

    const raw2 = policyFor("We permit up to 2 dogs with an extra fee of $250 per stay.");
    assert.strictEqual(raw2.petsAllowed, true);
    assert.strictEqual(raw2.maxDogs, 2);
    const raw4 = policyFor("2 dogs (under 50 lbs)");
    assert.strictEqual(raw4.petsAllowed, true);
    assert.strictEqual(raw4.maxDogs, 2);
    assert.strictEqual(raw4.weightPerDog, "50 lbs");

    const badge4 = deriveSearchBadge(normalizePolicy(raw4));
    assert.strictEqual(badge4.text, "Max 2 dogs allowed · 50 lbs");

    const raw5 = policyFor("Dogs and cats allowed");
    assert.strictEqual(raw5.petsAllowed, true);

    const raw6 = policyFor("Cats and dogs welcome, max 1 dog, up to 50 lbs.");
    assert.strictEqual(raw6.petsAllowed, true);
    assert.strictEqual(raw6.maxDogs, 1);
    assert.strictEqual(raw6.weightPerDog, "50 lbs");

    const raw7 = policyFor("Dogs must me under 25 pds .");
    assert.strictEqual(raw7.weightPerDog, "25 lbs");

    const raw8 = policyFor("Pet fee 100.00");
    assert.strictEqual(raw8.fee, "$100.00");

    const raw9 = policyFor("There is a 200 pet fee for the whole trip");
    assert.strictEqual(raw9.fee, "$200");
    assert.strictEqual(raw9.maxDogs, null);
  });
});

test("extractPropertyId and walkApolloNode pure helpers", async (t) => {
  const { extractPropertyId, walkApolloNode } = require("../extract.js");

  await t.test("extractPropertyId parses various Vrbo URL formats and pathnames", () => {
    assert.strictEqual(extractPropertyId("https://www.vrbo.com/12345?chkin=2026"), "12345");
    assert.strictEqual(extractPropertyId("https://www.vrbo.com/p12345"), "12345");
    assert.strictEqual(extractPropertyId("/vacation-rentals/p987654/"), "987654");
    assert.strictEqual(extractPropertyId("/pdp/5551212"), "5551212");
    assert.strictEqual(extractPropertyId("/pdp/lo/444333"), "444333");
    assert.strictEqual(extractPropertyId("invalid-url"), null);
    assert.strictEqual(extractPropertyId(null), null);
  });

  await t.test("walkApolloNode resolves references and extracts leaf items", () => {
    const state = {
      "PetPolicy:1": {
        __typename: "PetPolicy",
        header: { text: "Pets" },
        value: "Dogs welcome up to 50 lbs with $50 fee",
      },
      "Property:1": {
        __typename: "Property",
        petPolicy: { __ref: "PetPolicy:1" },
        unit: { __typename: "RentalUnit", name: "Child unit to ignore" },
      }
    };
    const out = [];
    walkApolloNode(state, state["Property:1"], null, null, out);
    assert.strictEqual(out.length, 2);
    assert.ok(out.some((item) => item.text === "Dogs welcome up to 50 lbs with $50 fee" && item.isDedicatedPetsHeader));
    assert.ok(out.some((item) => item.text === "Pets" && item.isDedicatedPetsHeader));
  });
});







