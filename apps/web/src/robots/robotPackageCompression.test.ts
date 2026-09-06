import JSZip from "jszip";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { robotDefinition } from "../viewer/robotPoseTestFixture";
import { compressRobotPackage } from "./robotPackageCompression";

const fetchBuffer = vi.hoisted(() => vi.fn());
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: fetchBuffer }));
afterEach(() => vi.clearAllMocks());

function fixture(files: Map<string, Uint8Array<ArrayBuffer>>, format: "zip" | "urdf" = "zip") {
  const robot = robotDefinition();
  robot.resources = [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }));
  return { id: "asset", name: `arm.${format}`, format, sourceUrl: `/source/arm.${format}`, manifest: { robot } } as ModelRecord;
}
const xml = new TextEncoder().encode('<robot name="arm"><link name="base"/></robot>');
const controller = () => new AbortController();

describe("lossless robot package compression", () => {
  it("preserves every XML/mesh byte and chosen entry in an ordinary compressed ZIP", async () => {
    const files = new Map([["robot.urdf", xml], ["other.urdf", xml], ["mesh/body.stl", new Uint8Array([1, 2, 3, 4])]]);
    const source = new JSZip(); for (const [path, data] of files) source.file(path, data);
    fetchBuffer.mockResolvedValue(await source.generateAsync({ type: "arraybuffer", compression: "STORE" }));
    const result = await compressRobotPackage(fixture(files), controller().signal);
    expect(result.name).toBe("arm.compressed.zip");
    const output = await JSZip.loadAsync(await result.arrayBuffer());
    for (const [path, data] of files) expect(await output.file(path)!.async("uint8array")).toEqual(data);
    expect(Object.values(output.files).filter(entry => !entry.dir)).toHaveLength(files.size);
  });
  it("wraps a single URDF without flattening its description", async () => {
    fetchBuffer.mockResolvedValue(xml.buffer);
    const result = await compressRobotPackage(fixture(new Map([["robot.urdf", xml]]), "urdf"), controller().signal);
    expect(await (await JSZip.loadAsync(await result.arrayBuffer())).file("robot.urdf")!.async("uint8array")).toEqual(xml);
  });
  it("rejects changed source bytes before generating any optimization result", async () => {
    fetchBuffer.mockResolvedValue(new TextEncoder().encode("corrupt").buffer);
    await expect(compressRobotPackage(fixture(new Map([["robot.urdf", xml]]), "urdf"), controller().signal)).rejects.toThrow("校验失败");
  });
  it("honors cancellation and rejects ordinary geometry assets", async () => {
    const signal = controller(); signal.abort(); fetchBuffer.mockResolvedValue(xml.buffer);
    await expect(compressRobotPackage(fixture(new Map([["robot.urdf", xml]]), "urdf"), signal.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(compressRobotPackage({ format: "glb" } as ModelRecord, controller().signal)).rejects.toThrow("URDF");
  });
});
