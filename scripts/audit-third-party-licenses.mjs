import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(currentFile), "..");

function packageKeys(entry) {
  return entry.versions.map((version) => `${entry.name}@${version}`);
}

function hasMandatoryReciprocalTerms(expression) {
  if (!/(?:A?GPL|LGPL|MPL)-/i.test(expression)) return false;
  if (/\bOR\b/i.test(expression) && /(?:MIT|Apache-2\.0|BSD|ISC|UPL-1\.0)/i.test(expression)) return false;
  return true;
}

export function auditLicenseInventory(inventory, overrides, notices) {
  const failures = [];
  let packageVersionCount = 0;
  let overrideCount = 0;
  const reviewedReciprocalPackages = new Set();

  for (const [reportedLicense, entries] of Object.entries(inventory)) {
    for (const entry of entries) {
      for (const key of packageKeys(entry)) {
        packageVersionCount += 1;
        const needsOverride = reportedLicense === "Unknown" || reportedLicense === "BSD";
        const override = overrides[key];
        if (needsOverride && (!override?.license || !override?.evidence)) {
          failures.push(`${key} reports ${reportedLicense}; add a version-pinned, evidence-backed override`);
          continue;
        }

        if (needsOverride) overrideCount += 1;
        const effectiveLicense = override?.license ?? reportedLicense;
        if (!hasMandatoryReciprocalTerms(effectiveLicense)) continue;
        reviewedReciprocalPackages.add(entry.name);
        if (!notices.includes(`\`${entry.name}\``)) {
          failures.push(`${key} uses ${effectiveLicense} but is not identified in THIRD_PARTY_NOTICES.md`);
        }
      }
    }
  }

  return {
    failures,
    packageVersionCount,
    overrideCount,
    reviewedReciprocalPackages: [...reviewedReciprocalPackages].sort(),
  };
}

function loadPnpmInventory(root) {
  const executable = process.platform === "win32" ? process.env.ComSpec : "pnpm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "pnpm licenses list --prod --json"]
    : ["licenses", "list", "--prod", "--json"];
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "pnpm license inventory failed");
  }
  return JSON.parse(result.stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const inventory = loadPnpmInventory(repositoryRoot);
  const overrides = JSON.parse(readFileSync(resolve(repositoryRoot, "config/third-party-license-overrides.json"), "utf8"));
  const notices = readFileSync(resolve(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const result = auditLicenseInventory(inventory, overrides, notices);

  if (result.failures.length) {
    console.error(`Third-party license audit failed (${result.failures.length}):`);
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Third-party license audit passed: ${result.packageVersionCount} production package versions, `
      + `${result.overrideCount} evidence-backed overrides, ${result.reviewedReciprocalPackages.length} reciprocal packages reviewed.`,
    );
  }
}
