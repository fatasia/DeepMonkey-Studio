import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublishedApplicationRecord } from "../../packages/contracts/src/index.ts";

export interface DashboardMulticomponentFontCatalog {
  readonly layoutCapture: {
    readonly chromiumExecutable: string;
    readonly playwrightModule: string;
  };
  readonly fontCatalog: {
    readonly projectId: string;
    readonly applicationId: string;
    readonly applicationRevision: number;
    readonly fonts: readonly {
      readonly id: string; readonly objectKey: string; readonly mime: string; readonly revision: number;
      readonly sha256: string; readonly faceIndex: number;
      readonly license: { readonly redistributable: true; readonly evidence: string };
    }[];
    readonly nodes: readonly {
      readonly nodeId: string; readonly fonts: readonly string[];
      readonly textStyle: {
        readonly fontSize: number; readonly fontWeight: 400 | 700; readonly fontStyle: "normal";
        readonly lineHeight: number; readonly color: readonly [number, number, number, number]; readonly align: "left";
      };
    }[];
  };
}

const NODE_TEXT_STYLES = {
  "mc-bar": { fontSize: 18, lineHeight: 27 },
  "mc-text": { fontSize: 22, lineHeight: 33 },
  "mc-kpi": { fontSize: 20, lineHeight: 30 },
} as const;

/** 中文验收字体绑定：多节点共享同一套 OFL 冻结字节，textStyle 是栅格基线,实测权重由采集宿主报告。 */
export async function dashboardMulticomponentFixture(directory: string, publication: PublishedApplicationRecord):
  Promise<DashboardMulticomponentFontCatalog> {
  const manifestFile = process.env.DASHBOARD_HEADING_FONT_MANIFEST;
  if (!manifestFile || !path.isAbsolute(manifestFile)) throw new Error("Set DASHBOARD_HEADING_FONT_MANIFEST to an absolute licensed font manifest");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const fontEntries = [];
  for (const weight of [400, 700] as const) {
    const selected = manifest.find((entry: any) => entry.layoutFace?.weight === weight && entry.layoutFace?.style === "normal");
    assert(selected && path.isAbsolute(selected.path) && path.isAbsolute(selected.licensePath), `Missing licensed ${weight} font`);
    const license = await readFile(selected.licensePath, "utf8");
    assert(license.replaceAll("\n", " ").replace(/\s+/g, " ").includes("SIL Open Font License, Version 1.1"),
      "Acceptance font must carry its OFL record");
    const bytes = await readFile(selected.path), sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `notocjk-${weight}`, objectKey = `projects/${publication.projectId}/fonts/${id}.otf`;
    const target = path.join(directory, "isolated-objects", objectKey);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    fontEntries.push({ id, objectKey, mime: "font/otf", revision: 1, sha256, faceIndex: 0,
      license: { redistributable: true as const, evidence: `OFL-1.1; ${selected.source}; sha256=${sha256}` } });
  }
  const textStyle = (nodeId: keyof typeof NODE_TEXT_STYLES, fontWeight: 400 | 700) => ({
    fontSize: NODE_TEXT_STYLES[nodeId].fontSize, fontWeight, fontStyle: "normal" as const,
    lineHeight: NODE_TEXT_STYLES[nodeId].lineHeight, color: [238, 242, 244, 255] as const, align: "left" as const,
  });
  return {
    layoutCapture: { chromiumExecutable: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      playwrightModule: path.resolve("apps/cloud-render-worker/node_modules/playwright-core/index.js") },
    fontCatalog: {
      projectId: publication.projectId, applicationId: publication.applicationId,
      applicationRevision: publication.applicationRevision, fonts: fontEntries,
      nodes: [
        { nodeId: "mc-bar", fonts: ["notocjk-400", "notocjk-700"], textStyle: textStyle("mc-bar", 400) },
        { nodeId: "mc-text", fonts: ["notocjk-400"], textStyle: textStyle("mc-text", 400) },
        { nodeId: "mc-kpi", fonts: ["notocjk-400", "notocjk-700"], textStyle: textStyle("mc-kpi", 400) },
      ],
    },
  };
}
