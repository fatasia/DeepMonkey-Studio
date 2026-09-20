import { describe, expect, it } from "vitest";
import { buildDeepShaderPackage } from "../shaderPackage/index.js";
import { FrameCaptureSession } from "./frameCapture.js";
import { PbrFrameCapture } from "../webgpu/pbrFrameCapture.js";
import { buildPbrFrameExecutionPlan } from "../webgpu/pbrFramePlanExecutor.js";
import { describePbrOpaquePass } from "../webgpu/pbrOpaquePass.js";
import {
  frameCaptureSourceMapRefsByPass,
  frameCaptureSourceMapRefsForShaderPass,
} from "./shaderSourceMap.js";

const CODE = `@vertex fn vertexMain() -> @builtin(position) vec4f {
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f {
  return vec4f(1.0, 0.5, 0.25, 1.0);
}
`;

function packageValue() {
  const result = buildDeepShaderPackage({
    packageId: "deep.r12.source-map",
    packageVersion: "1.0.0",
    compilerVersion: "0.2.0",
    passes: [{
      techniqueId: "pbr",
      passId: "forward",
      kind: "forward",
      module: { label: "deep.r12/forward", code: CODE },
      entryPoints: { vertex: "vertexMain", fragment: "fragmentMain" },
      sourceMap: [
        { stage: "vertex", nodeId: "position", generatedLine: 2 },
        { stage: "fragment", nodeId: "color", generatedLine: 5 },
      ],
      pipeline: {
        passVariantId: "forward-plain",
        attachmentProfileId: "forward-opaque",
        alphaMode: "OPAQUE",
        rasterMode: "ccw",
      },
    }],
  });
  if (!result.success || !result.value) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

describe("R12 shader package source-map adapter", () => {
  it("connects a built package through capture configuration to source lookup", () => {
    const shaderPackage = packageValue();
    const session = new FrameCaptureSession();
    let timestamp = 0;
    const capture = new PbrFrameCapture({ session, now: () => timestamp++, shaderPackage,
      shaderPassBindings: [{ capturePassId: "opaque", shaderPassId: "pbr/forward" }] });
    capture.begin("frame-1", buildPbrFrameExecutionPlan({ width: 64, height: 32 }, { transparency: false }));
    capture.recordPasses([describePbrOpaquePass()]);
    capture.end();
    expect(session.findBySourceMap({ moduleId: shaderPackage.passes[0]!.moduleId, nodeId: "color" }))
      .toEqual([{ frameId: "frame-1", passId: "opaque", sourceMap: {
        moduleId: shaderPackage.passes[0]!.moduleId, stage: "fragment", nodeId: "color", generatedLine: 5,
      } }]);
    expect(session.findBySourceMap({ nodeId: "missing" })).toEqual([]);
  });

  it("rejects incomplete or ambiguous capture source-map configuration before opening a frame", () => {
    const session = new FrameCaptureSession();
    const shaderPackage = packageValue();
    expect(() => new PbrFrameCapture({ session, shaderPackage })).toThrow("provided together");
    expect(() => new PbrFrameCapture({ session, shaderPassBindings: [] })).toThrow("provided together");
    expect(() => new PbrFrameCapture({ session, shaderPackage, shaderPassBindings: [],
      sourceMapRefsByPass: new Map() })).toThrow("not both");
    expect(session.activeFrameId).toBeUndefined();
    expect(session.records()).toEqual([]);
  });

  it("qualifies package source-map entries with the executable module ID", () => {
    const pass = packageValue().passes[0]!;
    expect(frameCaptureSourceMapRefsForShaderPass(pass)).toEqual([
      { moduleId: pass.moduleId, stage: "vertex", nodeId: "position", generatedLine: 2 },
      { moduleId: pass.moduleId, stage: "fragment", nodeId: "color", generatedLine: 5 },
    ]);
  });

  it("maps real capture pass IDs only through explicit package bindings", () => {
    const value = packageValue();
    const refs = frameCaptureSourceMapRefsByPass(value, [{
      capturePassId: "opaque",
      shaderPassId: "pbr/forward",
    }]);
    expect([...refs.keys()]).toEqual(["opaque"]);
    expect(refs.get("opaque")?.[0]).toMatchObject({
      moduleId: value.passes[0]!.moduleId,
      nodeId: "position",
    });
  });

  it("fails closed for duplicate, missing, and malformed bindings", () => {
    const value = packageValue();
    expect(() => frameCaptureSourceMapRefsByPass(value, [
      { capturePassId: "opaque", shaderPassId: "pbr/forward" },
      { capturePassId: "opaque", shaderPassId: "pbr/forward" },
    ])).toThrow("Duplicate frame capture shader binding opaque");
    expect(() => frameCaptureSourceMapRefsByPass(value, [
      { capturePassId: "opaque", shaderPassId: "pbr/missing" },
    ])).toThrow("pbr/missing is not available");
    expect(() => frameCaptureSourceMapRefsByPass(value, [
      { capturePassId: "", shaderPassId: "pbr/forward" },
    ])).toThrow("capturePassId");
    expect(() => frameCaptureSourceMapRefsByPass(value, [
      { capturePassId: "bad id", shaderPassId: "pbr/forward" },
    ])).toThrow("capturePassId");
    expect(() => frameCaptureSourceMapRefsByPass({ passes: [...value.passes, value.passes[0]!] }, [
      { capturePassId: "opaque", shaderPassId: "pbr/forward" },
    ])).toThrow("Duplicate shader package pass");
  });
});
