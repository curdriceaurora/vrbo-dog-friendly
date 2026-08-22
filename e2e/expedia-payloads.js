// e2e/expedia-payloads.js
// Minimal Expedia microdata/JSON-LD page fixtures for real extension wiring.

const PET_FEE_PAYLOAD = {
  title: "stayAPT Suites Pensacola-UWF/West Florida Hospital Area",
  url: "https://www.expedia.com/Pensacola-Hotels-StayAPT-Suites-Pensacola-UWFWest-Florida-Hospital-Area.h102382938.Hotel-Information",
  meta: [
    "Pets allowed for an extra charge of USD 25 per pet, per night (maximum USD 150 per stay)",
    "Service animals are welcome, and are exempt from fees",
    "Welcoming dogs and cats only",
    "2 total (up to 75 lbs per pet)",
  ],
  faqAnswer: "Yes, this property allows cats and dogs (limit 2 total) with a maximum weight of up to 75 lbs per pet. There's a fee of USD 25 per pet, per night. Service animals are exempt from fees.",
};

const NO_PETS_PAYLOAD = {
  title: "No Pets Test Hotel",
  url: "https://www.expedia.com/Test-Hotels-No-Pets-Test-Hotel.h987654321.Hotel-Information",
  meta: ["No pets allowed"],
  faqAnswer: "No, pets are not allowed at this property.",
};

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pageHtml(payload) {
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `Is ${payload.title} pet-friendly? `,
        acceptedAnswer: {
          "@type": "Answer",
          text: payload.faqAnswer,
        },
      },
    ],
  };
  const metas = payload.meta.map((content) => `<meta itemprop="petsAllowed" content="${escapeAttr(content)}">`).join("\n    ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeAttr(payload.title)}</title>
    <link rel="canonical" href="${escapeAttr(payload.url)}">
    ${metas}
    <script type="application/ld+json">${JSON.stringify(faq)}</script>
  </head>
  <body>
    <main data-stid="lodging-infosite-template-api-renderer">
      <h1>${escapeAttr(payload.title)}</h1>
    </main>
  </body>
</html>`;
}

module.exports = {
  PET_FEE_PAYLOAD,
  NO_PETS_PAYLOAD,
  pageHtml,
};
