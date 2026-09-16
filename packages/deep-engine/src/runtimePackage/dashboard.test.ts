import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDashboardRuntimePackage, parseDeepRuntimePackage, serializeDeepRuntimePackage } from "./index.js";
import type { Deep2dRuntimePackage } from "./types.js";

const fixture = (): Deep2dRuntimePackage => JSON.parse(readFileSync(new URL("../../../deep-engine-native/fixtures/deep2d_runtime_atlas_v1.json", import.meta.url), "utf8"));
describe("standalone dashboard runtime package", () => {
  it("packages real path and atlas content without dummy scene geometry", () => {
    const deep2d = fixture();
    const result = buildDashboardRuntimePackage({ packageId: "dashboard.main", packageVersion: "1.0.0", deep2d });
    const golden = JSON.parse(readFileSync(new URL("../../fixtures/dashboard-runtime-v1.json", import.meta.url), "utf8"));
    expect(result).toEqual(golden);
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(result)).valid).toBe(true);
    expect(result.payloads[result.entrypoints.renderPacket]).toMatchObject({geometries: [], materials: [], instances: [], textures: []});
    expect(result.payloads[result.entrypoints.deep2d!]).toEqual(deep2d);
    const original = serializeDeepRuntimePackage(result);
    (deep2d as {id: string}).id = "changed";
    expect(serializeDeepRuntimePackage(result)).toBe(original);
  });
  it("keeps packet identity stable across revisions and rejects corrupt pixels", () => {
    const deep2d = fixture();
    const create = (content: Deep2dRuntimePackage) => buildDashboardRuntimePackage({packageId:"dashboard.main", packageVersion:"1.0.0", deep2d:content});
    const before = create(deep2d), after = create({...deep2d, revision:deep2d.revision+1});
    expect(after.entrypoints.renderPacket).toBe(before.entrypoints.renderPacket);
    expect(after.packageHash).not.toEqual(before.packageHash);
    expect(() => create({...deep2d, atlases:deep2d.atlases.map(atlas => ({...atlas, dataBase64:"AA=="}))})).toThrow();
    expect(create(fixture())).toEqual(before);
  });
});
