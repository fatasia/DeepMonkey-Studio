import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type { VisionModelManifest } from "@bim-studio/contracts";
import { extractOnnxPayload, parseOutputs, prepareImage, visionSessionOptions } from "./vision.js";

function manifest(format: VisionModelManifest["output"]["format"]): VisionModelManifest {
  return {
    schemaVersion: 1,
    name: "YOLO test",
    version: "1",
    task: "detection",
    input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
    output: { format, coordinates: "input-pixels", nmsIncluded: format === "yolo-nms" },
    labels: ["person", "defect"],
    threshold: 0.5,
    iouThreshold: 0.45
  };
}

describe("YOLO output adapters", () => {
  it("parses YOLOv8/v10/v11 feature-first 4+C output", () => {
    const tensor = new ort.Tensor("float32", Float32Array.from([
      320, 100,
      320, 100,
      100, 20,
      100, 20,
      0.9, 0.1,
      0.1, 0.8
    ]), [1, 6, 2]);

    const result = parseOutputs({ output0: tensor }, manifest("yolo"), 0.5, 0.45);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.label)).toEqual(["person", "defect"]);
    expect(result[0]?.bbox).toEqual([0.421875, 0.421875, 0.578125, 0.578125]);
  });

  it("parses YOLOv5/v7 row-first 5+C output with objectness", () => {
    const tensor = new ort.Tensor("float32", Float32Array.from([320, 320, 160, 80, 0.8, 0.1, 0.9]), [1, 1, 7]);

    const result = parseOutputs({ output: tensor }, manifest("yolo"), 0.5, 0.45);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ label: "defect", classId: 1 });
    expect(result[0]?.confidence).toBeCloseTo(0.72, 5);
  });

  it("parses exported YOLO NMS Nx6 output", () => {
    const config = manifest("yolo-nms");
    config.output.coordinates = "normalized";
    const tensor = new ort.Tensor("float32", Float32Array.from([0.1, 0.2, 0.5, 0.7, 0.91, 1]), [1, 1, 6]);

    const result = parseOutputs({ detections: tensor }, config, 0.5, 0.45);

    expect(result[0]).toMatchObject({ label: "defect", classId: 1 });
    expect(result[0]?.confidence).toBeCloseTo(0.91, 5);
    expect(result[0]?.bbox?.[0]).toBeCloseTo(0.1, 5);
    expect(result[0]?.bbox?.[1]).toBeCloseTo(0.2, 5);
    expect(result[0]?.bbox?.[2]).toBeCloseTo(0.5, 5);
    expect(result[0]?.bbox?.[3]).toBeCloseTo(0.7, 5);
  });

  it("decodes the official YOLOX grid and stride output", () => {
    const config = manifest("yolox");
    config.input.width = 32;
    config.input.height = 32;
    const values = new Float32Array(21 * 7);
    const offset = 5 * 7;
    values.set([0, 0, 0, 0, 0.9, 0.1, 0.8], offset);
    const tensor = new ort.Tensor("float32", values, [1, 21, 7]);

    const result = parseOutputs({ output: tensor }, config, 0.5, 0.45);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ label: "defect", classId: 1 });
    expect(result[0]?.confidence).toBeCloseTo(0.72, 5);
    expect(result[0]?.bbox).toEqual([0.125, 0.125, 0.375, 0.375]);
  });
});

describe("vision preprocessing", () => {
  it("creates NHWC uint8 input required by the SSD preset", async () => {
    const config = manifest("ssd");
    config.input = { width: 16, height: 12, channels: 3, layout: "NHWC", color: "RGB", resize: "stretch", dataType: "uint8", scale: 1 };
    const image = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();

    const prepared = await prepareImage(image, config);

    expect(prepared.dims).toEqual([1, 12, 16, 3]);
    expect(prepared.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(prepared.data.slice(0, 3))).toEqual([255, 0, 0]);
  });
});

describe("vision execution providers", () => {
  it("configures DirectML with the required sequential execution settings", () => {
    expect(visionSessionOptions("directml", 2)).toMatchObject({
      executionProviders: [{ name: "dml", deviceId: 2 }],
      executionMode: "sequential",
      enableMemPattern: false,
      graphOptimizationLevel: "all"
    });
  });

  it("keeps an explicit CPU fallback configuration", () => {
    expect(visionSessionOptions("cpu", 0)).toEqual({ executionProviders: ["cpu"], graphOptimizationLevel: "all" });
  });
});

describe("vision preset packages", () => {
  it("extracts the ONNX entry from a gzip tar preset", () => {
    const model = Buffer.from([8, 1, 18, 3, 111, 110, 120]);
    const header = Buffer.alloc(512);
    header.write("models/best.onnx");
    header.write(model.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    const padding = Buffer.alloc(Math.ceil(model.length / 512) * 512 - model.length);
    const archive = gzipSync(Buffer.concat([header, model, padding, Buffer.alloc(1024)]));

    expect(extractOnnxPayload(archive)).toEqual(model);
    expect(extractOnnxPayload(model)).toBe(model);
  });
});
