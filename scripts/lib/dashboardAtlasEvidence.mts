import assert from "node:assert/strict";
import { createHash } from "node:crypto";

interface Atlas { id: string; width: number; height: number; format: string; kind: string;
  sampling: string; bytes: number; sha256: string }

/** Match frozen pixel resources against the actual prepared renderer, allowing generated labels. */
export function assertDashboardAtlasEvidence(log: string, runtimePackage: Uint8Array) {
  const payloads = JSON.parse(Buffer.from(runtimePackage).toString("utf8")).payloads;
  const frozen: Atlas[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.atlases)) for (const item of object.atlases) {
      assert(typeof item.dataBase64 === "string", "frozen atlas must contain pixels");
      const bytes = Buffer.from(item.dataBase64, "base64");
      frozen.push({ id: item.id, width: item.width, height: item.height, format: item.format,
        kind: item.kind, sampling: item.sampling, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    for (const [key, child] of Object.entries(object)) if (key !== "atlases") {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(payloads);
  assert(frozen.length > 0, "acceptance fixture requires frozen source atlases");
  const line = log.split(/\r?\n/).find(value => value.startsWith("native Deep2d atlas inventory: "));
  assert(line, "renderer prepared atlas inventory is missing");
  const prepared: Atlas[] = JSON.parse(line.slice("native Deep2d atlas inventory: ".length));
  assert(Array.isArray(prepared), "renderer atlas inventory must be an array");
  const remaining = [...prepared], matches: Array<{sourceId: string; preparedId: string; sha256: string}> = [];
  for (const source of frozen) {
    const index = remaining.findIndex(atlas => atlas.width === source.width && atlas.height === source.height
      && atlas.format === source.format && atlas.kind === source.kind && atlas.sampling === source.sampling
      && atlas.bytes === source.bytes && atlas.sha256 === source.sha256);
    assert(index >= 0, `frozen atlas pixels/metadata missing from renderer: ${source.id}`);
    matches.push({ sourceId: source.id, preparedId: remaining[index]!.id, sha256: source.sha256 });
    remaining.splice(index, 1);
  }
  const summary = /native Deep2d atlases prepared: atlases=(\d+) bytes=(\d+) glyph_quads=(\d+) image_quads=(\d+) batches=(\d+) vertices=(\d+)/.exec(log);
  assert(summary, "prepared atlas summary is missing");
  assert.equal(Number(summary[1]), prepared.length, "prepared summary/inventory count mismatch");
  assert.equal(Number(summary[2]), prepared.reduce((total, atlas) => total + atlas.bytes, 0), "prepared pixel bytes mismatch");
  assert(Number(summary[5]) > 0 && Number(summary[6]) > 0, "prepared atlas draw batches must exist");
  return { frozen: frozen.length, prepared: prepared.length, generated: remaining.length, matches };
}
