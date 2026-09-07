import assert from "node:assert/strict";
import test from "node:test";
import { refreshedSourceBEvidence } from "./sourceBEvidenceRefresh.mjs";

const uid = "001970c2594e4aa6bef46e63fc9e0c5a";
const record = { uid, name: "local", bytes: 42, sha256: "hash", publicationStatus: "review-required" };
const detail = { uid, name: "Official", license: { url: "http://creativecommons.org/licenses/by/4.0/" }, user: { displayName: "Author" } };
const inspection = { valid: true, bytes: 42, sha256: "hash", meshCount: 1, primitiveCount: 1, externalUris: [] };
test("refreshes verified metadata without claiming publication or changing original identity", () => {
  const next = refreshedSourceBEvidence(record, detail, inspection, "2026-09-07T00:00:00Z");
  assert.equal(next.license, "CC-BY-4.0"); assert.equal(next.publicationStatus, "review-required");
  assert.equal(next.name, "local"); assert.equal(next.sha256, "hash"); assert.equal(record.license, undefined);
  assert.equal(next.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
});
test("rejects changed files, mismatched identities, and restricted licenses", () => {
  assert.throws(() => refreshedSourceBEvidence(record, { ...detail, uid: "wrong" }, inspection, "now"), /UID/);
  assert.throws(() => refreshedSourceBEvidence(record, detail, { ...inspection, sha256: "changed" }, "now"), /哈希/);
  assert.throws(() => refreshedSourceBEvidence(record, { ...detail, license: { url: "https://creativecommons.org/licenses/by-nc/4.0/" } }, inspection, "now"), /许可/);
});
