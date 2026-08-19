#!/usr/bin/env node
// tools/build-zip.js
// Packages src/ into dist/vrbow-vX.Y.Z.zip for Chrome Web Store submission.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");
const DIST_DIR = path.join(ROOT, "dist");

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8"));
  const version = manifest.version;
  if (!version) {
    console.error("❌ src/manifest.json has no \"version\" field.");
    process.exit(1);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipName = `vrbow-v${version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);

  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath);
  }

  // Zip the CONTENTS of src/ (not a wrapping src/ directory), so the
  // archive root is exactly what Chrome expects to unpack an extension from.
  const entries = fs.readdirSync(SRC_DIR);
  execFileSync("zip", ["-r", "-X", zipPath, ...entries], { cwd: SRC_DIR, stdio: "inherit" });

  console.log(`✅ Built ${path.relative(ROOT, zipPath)}`);
}

main();
