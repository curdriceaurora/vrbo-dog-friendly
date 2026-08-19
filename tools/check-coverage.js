#!/usr/bin/env node
// tools/check-coverage.js
// 8.2.4: Publish and enforce JavaScript coverage expectations for Node modules.

const { spawn } = require("node:child_process");

const THRESHOLDS = {
  line: 90.0,
  branch: 75.0,
  funcs: 85.0,
};

function runNodeCoverage() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--test", "--experimental-test-coverage"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      const str = chunk.toString();
      stdout += str;
      process.stdout.write(str);
    });

    proc.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderr += str;
      process.stderr.write(str);
    });

    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

function parseCoverageTable(output) {
  const lines = output.split("\n");
  const reports = {};

  for (const line of lines) {
    // Match line format: ℹ filename.js |  93.84 |    83.52 |   96.30 | uncovered
    const match = /ℹ\s+([\w.-]+|\b[a-z ]+files\b)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i.exec(line);
    if (match) {
      const file = match[1].trim();
      reports[file] = {
        line: parseFloat(match[2]),
        branch: parseFloat(match[3]),
        funcs: parseFloat(match[4]),
      };
    }
  }

  return reports;
}

async function main() {
  console.log("\n===============================================================================");
  console.log("8.2.4 Node Module Coverage Verification");
  console.log(`Thresholds: Lines >= ${THRESHOLDS.line}%, Branches >= ${THRESHOLDS.branch}%, Functions >= ${THRESHOLDS.funcs}%`);
  console.log("===============================================================================\n");

  const result = await runNodeCoverage();

  if (result.code !== 0) {
    console.error(`\n❌ Node test execution failed with exit code ${result.code}`);
    process.exit(result.code || 1);
  }

  const reports = parseCoverageTable(result.stdout);

  if (Object.keys(reports).length === 0) {
    console.error("\n❌ Could not parse coverage table from Node test runner output.");
    process.exit(1);
  }

  let failed = false;
  console.log("\n-------------------------------------------------------------------------------");
  console.log("Coverage Threshold Evaluation");
  // Note: content.js, popup.js, and page-bridge.js are browser-coupled scripts whose
  // browser-path coverage is measured and enforced via Playwright in e2e/js-coverage.spec.js.
  // check-coverage.js specifically enforces Node module thresholds for standalone modules.
  const TARGET_NODE_MODULES = new Set(["extract.js", "search-fetcher.js"]);

  const missing = [...TARGET_NODE_MODULES].filter((f) => !reports[f]);
  if (missing.length) {
    console.error(`\n❌ Coverage rows missing for: ${missing.join(", ")}`);
    process.exit(1);
  }

  for (const [file, metrics] of Object.entries(reports)) {
    if (!TARGET_NODE_MODULES.has(file)) continue;
    const linePass = metrics.line >= THRESHOLDS.line;
    const branchPass = metrics.branch >= THRESHOLDS.branch;
    const funcsPass = metrics.funcs >= THRESHOLDS.funcs;

    const status = linePass && branchPass && funcsPass ? "✅ PASS" : "❌ FAIL";
    console.log(`${status} [${file}] Line: ${metrics.line}% | Branch: ${metrics.branch}% | Funcs: ${metrics.funcs}%`);

    if (!linePass || !branchPass || !funcsPass) {
      failed = true;
      if (!linePass) console.error(`   - Line coverage ${metrics.line}% is below threshold ${THRESHOLDS.line}%`);
      if (!branchPass) console.error(`   - Branch coverage ${metrics.branch}% is below threshold ${THRESHOLDS.branch}%`);
      if (!funcsPass) console.error(`   - Function coverage ${metrics.funcs}% is below threshold ${THRESHOLDS.funcs}%`);
    }
  }

  console.log("-------------------------------------------------------------------------------\n");

  if (failed) {
    console.error("❌ Coverage expectations not met. Regressions detected.");
    process.exit(1);
  } else {
    console.log("✅ All Node module coverage expectations met!");
  }
}

main().catch((err) => {
  console.error("Unexpected error in check-coverage:", err);
  process.exit(1);
});
