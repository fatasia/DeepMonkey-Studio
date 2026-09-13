import { describe, expect, it } from "vitest";
import { SHADER_AUTHORING_BUDGETS } from "./types.js";
import { graphDocument, textDocument } from "./testFixture.js";
import { validateShaderAuthoringDocument, validateShaderAuthoringSnapshot } from "./validation.js";

describe("shader authoring input boundaries", () => {
  it("does not execute accessors while validating documents", () => {
    let reads = 0;
    const document = textDocument() as unknown as Record<string, unknown>;
    Object.defineProperty(document, "source", {
      enumerable: true,
      get: () => { reads += 1; return "poison"; },
    });
    const result = validateShaderAuthoringDocument(document);
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("non-deterministic");
    expect(reads).toBe(0);
  });

  it("fails closed on throwing proxies, cycles, sparse arrays, and non-finite numbers", () => {
    const throwing = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    expect(validateShaderAuthoringDocument(throwing).diagnostics[0]?.code).toBe("non-deterministic");

    const cyclic = textDocument() as unknown as Record<string, unknown>;
    cyclic.loop = cyclic;
    expect(validateShaderAuthoringDocument(cyclic).diagnostics[0]?.code).toBe("non-deterministic");

    const sparse = graphDocument() as unknown as { asset: { techniques: unknown[] } };
    sparse.asset.techniques = new Array(2);
    expect(validateShaderAuthoringDocument(sparse).diagnostics.some((entry) => entry.code === "non-deterministic")).toBe(true);

    const number = graphDocument() as unknown as { asset: { techniques: Array<{ passes: Array<{ vertex: { nodes: Array<{ value: number[] }> } }> }> } };
    number.asset.techniques[0]!.passes[0]!.vertex.nodes[0]!.value[0] = Number.NaN;
    expect(validateShaderAuthoringDocument(number).diagnostics.some((entry) => entry.code === "non-deterministic")).toBe(true);
  });

  it("enforces source, global-node, and snapshot-history budgets", () => {
    const oversized = textDocument("x".repeat(SHADER_AUTHORING_BUDGETS.maxSourceLength + 1));
    expect(validateShaderAuthoringDocument(oversized).diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);

    const history = Array.from({ length: SHADER_AUTHORING_BUDGETS.maxHistoryEntries + 1 }, (_, index) => textDocument(String(index)));
    const snapshot = { schemaVersion: 1, historyLimit: SHADER_AUTHORING_BUDGETS.maxHistoryEntries, document: textDocument(), undo: history, redo: [] };
    expect(validateShaderAuthoringSnapshot(snapshot).diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);

    const nodes = { ...textDocument(), extra: Array.from({ length: SHADER_AUTHORING_BUDGETS.maxInputNodes + 1 }, () => 1) };
    expect(validateShaderAuthoringDocument(nodes).diagnostics.some((entry) => entry.code === "budget-exceeded")).toBe(true);
  });

  it("rejects unknown versions, modes, fields, and corrupted serialized snapshots", () => {
    expect(validateShaderAuthoringDocument({ ...textDocument(), schemaVersion: 2 }).valid).toBe(false);
    expect(validateShaderAuthoringDocument({ ...textDocument(), mode: "wgsl" }).valid).toBe(false);
    expect(validateShaderAuthoringDocument({ ...textDocument(), parserReady: true }).diagnostics[0]?.code).toBe("unknown-field");
    expect(validateShaderAuthoringSnapshot("{broken").diagnostics[0]?.code).toBe("invalid-value");
    expect(validateShaderAuthoringSnapshot({ schemaVersion: 1, historyLimit: 64, document: textDocument(), undo: [], redo: [], compiled: true }).diagnostics[0]?.code).toBe("unknown-field");
  });

  it("returns immutable snapshots detached from caller mutation", () => {
    const input = textDocument("original") as { source: string } & ReturnType<typeof textDocument>;
    const result = validateShaderAuthoringDocument(input);
    input.source = "mutated";
    expect(result.value).toMatchObject({ source: "original" });
    expect(() => { (result.value as { source: string }).source = "bad"; }).toThrow();
  });
});
