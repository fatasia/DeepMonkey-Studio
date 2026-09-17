import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublishedApplicationRecord } from "../../packages/contracts/src/index.ts";

/** A local OFL font manifest supplies the existing real regular/bold test corpus. */
export async function dashboardPublishedHeadingFixture(directory: string, publication: PublishedApplicationRecord) {
  const manifestFile = process.env.DASHBOARD_HEADING_FONT_MANIFEST;
  if (!manifestFile || !path.isAbsolute(manifestFile)) throw new Error("Set DASHBOARD_HEADING_FONT_MANIFEST to an absolute licensed font manifest");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const fontEntries = [];
  for (const weight of [400, 700]) {
    const selected = manifest.find((entry: any) => entry.layoutFace?.weight === weight && entry.layoutFace?.style === "normal");
    assert(selected && path.isAbsolute(selected.path) && path.isAbsolute(selected.licensePath), `Missing licensed ${weight} font`);
    const license = await readFile(selected.licensePath, "utf8");
    assert(license.includes("SIL Open Font License, Version 1.1"), "Acceptance font must carry its OFL record");
    const bytes = await readFile(selected.path), sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `heading-${weight}`, objectKey = `projects/${publication.projectId}/fonts/${id}.ttf`;
    const target = path.join(directory, "isolated-objects", objectKey);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    fontEntries.push({ id, objectKey, mime: "font/ttf", revision: 1, sha256, faceIndex: 0,
      license: { redistributable: true, evidence: `OFL-1.1; ${selected.source}; sha256=${sha256}` } });
  }
  return {
    layoutCapture: { chromiumExecutable: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      playwrightModule: path.resolve("apps/cloud-render-worker/node_modules/playwright-core/index.js") },
    fontCatalog: { projectId: publication.projectId, applicationId: publication.applicationId,
      applicationRevision: publication.applicationRevision, fonts: fontEntries,
      nodes: [{ nodeId: "portable-author-bar", fonts: fontEntries.map(font => font.id), textStyle: {
        fontSize: 18, fontWeight: 400, fontStyle: "normal", lineHeight: 27, color: [238, 242, 244, 255], align: "left" } }] },
  };
}
