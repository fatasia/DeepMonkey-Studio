import { describe, expect, it } from "vitest";
import { sha256Utf8 } from "../shaderPackage/hash.js";
import { outputShader } from "./pbrOutputShader.js";
import { createPbrOutputShaderProvenance } from "./pbrOutputShaderProvenance.js";

describe("PBR executable output shader provenance", () => {
  it("maps exact generated WGSL entrypoint lines and memoizes bounded immutable refs", () => {
    const pipeline = {} as GPURenderPipeline;
    const source = createPbrOutputShaderProvenance(pipeline, outputShader);
    const refs = source.refsFor(pipeline);
    expect(refs).toHaveLength(2);
    expect(source.refsFor(pipeline)).toBe(refs);
    expect(Object.isFrozen(refs)).toBe(true);
    for (const ref of refs) {
      expect(Object.isFrozen(ref)).toBe(true);
      expect(ref.moduleId).toBe(`builtin.pbr-output.sha256-${sha256Utf8(outputShader)}`);
      expect(ref.nodeId).toBe(`wgsl.entrypoint.${ref.stage}Main`);
      expect(outputShader.split("\n")[ref.generatedLine - 1]).toContain(`@${ref.stage} fn ${ref.stage}Main`);
    }
  });
  it("rejects unrelated pipeline identity", () => {
    const source = createPbrOutputShaderProvenance({} as GPURenderPipeline, outputShader);
    expect(() => source.refsFor({} as GPURenderPipeline)).toThrow("executed pipeline");
  });
  it("does not parse or hash unused source and rejects over-budget requested source", () => {
    const pipeline = {} as GPURenderPipeline;
    const source = createPbrOutputShaderProvenance(pipeline, "x".repeat(1_048_577));
    expect(() => source.refsFor(pipeline)).toThrow("budget");
  });
  it("rejects missing or ambiguous entry points", () => {
    const pipeline = {} as GPURenderPipeline;
    expect(() => createPbrOutputShaderProvenance(pipeline, "").refsFor(pipeline)).toThrow("entry point");
    expect(() => createPbrOutputShaderProvenance(pipeline, `${outputShader}\n@vertex fn vertexMain() {}`).refsFor(pipeline)).toThrow("entry point");
  });
});
