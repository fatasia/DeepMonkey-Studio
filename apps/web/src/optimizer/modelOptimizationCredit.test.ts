import { Document, WebIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { preserveOptimizationCredit } from "./modelOptimizationCredit";

describe("GLB copyright preservation", () => {
  it("keeps existing copyright and writes credit into the actual binary asset", async () => {
    const document = new Document();
    document.getRoot().getAsset().copyright = "Original author";
    document.createScene();
    preserveOptimizationCredit(document, "Source author · CC-BY-4.0");
    preserveOptimizationCredit(document, "Source author · CC-BY-4.0");
    const io = new WebIO();
    const output = await io.writeBinary(document);
    const restored = await io.readBinary(output);
    expect(restored.getRoot().getAsset().copyright).toBe("Original author\n\nSource author · CC-BY-4.0");
  });
  it("does not invent metadata for local files without supplied credit", () => {
    const document = new Document(); preserveOptimizationCredit(document);
    expect(document.getRoot().getAsset().copyright).toBeUndefined();
  });
});
