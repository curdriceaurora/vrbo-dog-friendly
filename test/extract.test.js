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
const { extractPolicy, buildCorpus } = require("../extract.js");

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
    assert.strictEqual(policyFor("$25 per dog per night.").fee, "$25 per night");
  });

  await t.test("non-USD currencies", () => {
    assert.strictEqual(policyFor("Pet fee of €50.").fee, "€50");
    assert.strictEqual(policyFor("50 € pet fee.").fee, "€50");
    assert.strictEqual(policyFor("A £30 dog fee applies.").fee, "£30");
    assert.strictEqual(policyFor("AU$40 pet fee.").fee, "AU$40");
    assert.strictEqual(policyFor("Dog fee: 60,00 EUR").fee, "€60.00");
  });

  await t.test("deposit is separate from fee", () => {
    const p = policyFor("A $75 pet fee applies.", "Refundable pet deposit of $200.");
    assert.strictEqual(p.fee, "$75");
    assert.strictEqual(p.deposit, "$200");
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

  await t.test("de-dupes identical text, keeping the higher-priority source", () => {
    const entries = buildCorpus(payload, ["No aggressive breeds."]);
    const matches = entries.filter((e) => e.text === "No aggressive breeds.");
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].source, "House Rules / Policies");
  });
});
