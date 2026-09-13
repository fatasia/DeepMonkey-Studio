import assert from "node:assert/strict";
import test from "node:test";

import { auditLicenseInventory } from "./audit-third-party-licenses.mjs";

test("requires evidence-backed overrides for incomplete license metadata", () => {
  const inventory = {
    Unknown: [{ name: "legacy-package", versions: ["1.0.0"] }],
    BSD: [{ name: "ambiguous-bsd", versions: ["2.0.0"] }],
  };
  const result = auditLicenseInventory(inventory, {}, "");
  assert.deepEqual(result.failures, [
    "legacy-package@1.0.0 reports Unknown; add a version-pinned, evidence-backed override",
    "ambiguous-bsd@2.0.0 reports BSD; add a version-pinned, evidence-backed override",
  ]);
});

test("accepts exact-version overrides with evidence", () => {
  const inventory = { Unknown: [{ name: "legacy-package", versions: ["1.0.0"] }] };
  const overrides = {
    "legacy-package@1.0.0": { license: "MIT", evidence: "Complete MIT text in the package." },
  };
  const result = auditLicenseInventory(inventory, overrides, "");
  assert.deepEqual(result.failures, []);
  assert.equal(result.overrideCount, 1);
});

test("requires mandatory reciprocal dependencies to be documented", () => {
  const inventory = {
    "LGPL-2.1-only": [{ name: "reciprocal-wasm", versions: ["3.0.0"] }],
    "(MIT OR GPL-3.0-or-later)": [{ name: "permissive-choice", versions: ["4.0.0"] }],
  };
  const missing = auditLicenseInventory(inventory, {}, "");
  assert.deepEqual(missing.failures, [
    "reciprocal-wasm@3.0.0 uses LGPL-2.1-only but is not identified in THIRD_PARTY_NOTICES.md",
  ]);

  const documented = auditLicenseInventory(inventory, {}, "`reciprocal-wasm`");
  assert.deepEqual(documented.failures, []);
});
