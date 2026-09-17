import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dashboardPublishedHeadingFixture } from "./dashboardPublishedHeadingFixture.mts";

test("requires an explicit absolute licensed font manifest", async () => {
  const previous = process.env.DASHBOARD_HEADING_FONT_MANIFEST;
  process.env.DASHBOARD_HEADING_FONT_MANIFEST = "relative.json";
  try { await assert.rejects(dashboardPublishedHeadingFixture("unused", {} as never), /absolute licensed font manifest/); }
  finally { if (previous === undefined) delete process.env.DASHBOARD_HEADING_FONT_MANIFEST; else process.env.DASHBOARD_HEADING_FONT_MANIFEST = previous; }
});

test("copies only manifest-bound regular/bold bytes and rejects missing license evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-heading-catalog-"));
  const previous = process.env.DASHBOARD_HEADING_FONT_MANIFEST;
  try {
    const entries = [];
    for (const weight of [400, 700]) {
      const file = path.join(directory, `${weight}.ttf`), licensePath = path.join(directory, `${weight}.license`);
      await writeFile(file, Uint8Array.of(weight % 255, 2));
      await writeFile(licensePath, "SIL Open Font License, Version 1.1");
      entries.push({ path: file, licensePath, source: "test-only-font-record", layoutFace: { weight, style: "normal" } });
    }
    const manifest = path.join(directory, "fonts.json"); await writeFile(manifest, JSON.stringify(entries));
    process.env.DASHBOARD_HEADING_FONT_MANIFEST = manifest;
    const publication = { projectId: "project-test", applicationId: "application-test", applicationRevision: 2 } as never;
    const result = await dashboardPublishedHeadingFixture(directory, publication);
    assert.equal(result.fontCatalog.fonts.length, 2);
    assert.equal(result.fontCatalog.applicationRevision, 2);
    for (const font of result.fontCatalog.fonts) {
      const bytes = await readFile(path.join(directory, "isolated-objects", font.objectKey));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), font.sha256);
    }
    await writeFile(entries[0]!.licensePath, "No redistribution grant");
    await assert.rejects(dashboardPublishedHeadingFixture(directory, publication), /OFL record/);
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_HEADING_FONT_MANIFEST; else process.env.DASHBOARD_HEADING_FONT_MANIFEST = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
