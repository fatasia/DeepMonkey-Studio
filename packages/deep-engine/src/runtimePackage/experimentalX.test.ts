import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildExperimentalXRuntimePackage, freezeExperimentalXResource, parseDeepRuntimePackage,
  runtimeContentSha256, type BuildExperimentalXRuntimeInput, type XRequest } from "./index.js";

export const request = (): XRequest => ({ schemaVersion: 1, expectedEpoch: 7, startedAtMs: 100, randomSeed: 42,
  resources: [], events: [], calls: [{ op: "emit-number", args: 42 }] });
const input = (): BuildExperimentalXRuntimeInput => ({ packageId: "x.author", packageVersion: "1.0.0",
  renderPacket: { id: "scene.empty", revision: 1, value: { geometries: [], materials: [], instances: [] } },
  experimentalX: { id: "x:status", revision: 1, request: request() } });

describe("experimental X author compilation", () => {
  it("uses the Native request digest and existing package index/hash contract", () => {
    const frozen = freezeExperimentalXResource("x:status", 1, request());
    expect(frozen.payload.content.contentHash.value).toBe("5c15e6f3d0475b2bdb9952ae31d7d9d9d41f148cd5e6d26656842cb996d3cf3b");
    const compiled = buildExperimentalXRuntimePackage(input());
    expect(compiled.runtimePackage.schemaVersion).toBe(6);
    expect(compiled.runtimePackage.resources.map(entry => entry.id)).toEqual(["deep.builtin.studio-ibl.v1", "scene.empty", "x:status"]);
    expect(compiled.runtimePackage.resources[2]!.contentHash.value).toBe(runtimeContentSha256(compiled.runtimePackage.payloads["x:status"]));
    expect(parseDeepRuntimePackage(compiled.packageJson).valid).toBe(false);
    expect(buildExperimentalXRuntimePackage(input()).packageJson).toBe(compiled.packageJson);
    expect(compiled.packageJson).toBe(readFileSync(new URL("../../fixtures/experimental-x-runtime-v6.json", import.meta.url), "utf8").trim());
  });
  it("snapshots the request and rejects paths/scripts/activation and mixed roles", () => {
    const source = input(), compiled = buildExperimentalXRuntimePackage(source);
    (source.experimentalX.request.calls as unknown[]).push({ op: "read-clock" });
    expect(JSON.stringify(compiled.runtimePackage)).not.toContain("read-clock");
    for (const key of ["camera", "chart", "chartSim", "dashboard", "workerPath", "enabled", "budget", "script"]) {
      expect(() => buildExperimentalXRuntimePackage({ ...input(), [key]: null } as never)).toThrow();
      expect(() => freezeExperimentalXResource("x:status", 1, { ...request(), [key]: null } as never)).toThrow();
    }
  });
  it("checks resource/event references and every closed operation without evaluation", () => {
    const valid: XRequest = { ...request(), resources: [{ id: "asset", bytes: [255] }], events: [{ type: "key", data: { code: "enter" } }],
      calls: [{ op: "sequence", args: [{ op: "read-clock" }, { op: "draw-random" }, { op: "read-event", args: { index: 0 } },
        { op: "read-resource-byte", args: { resource_id: "asset", offset: 0 } }] }] };
    expect(freezeExperimentalXResource("x:status", 1, valid).payload.content.request).toEqual(valid);
    for (const calls of [[{ op: "read-event", args: { index: 1 } }], [{ op: "read-resource-byte", args: { resource_id: "missing", offset: 0 } }],
      [{ op: "emit-number", args: Infinity }], [{ op: "eval", args: "42" }]]) {
      expect(() => freezeExperimentalXResource("x:status", 1, { ...valid, calls } as never)).toThrow();
    }
  });
  it("freezes a validated Deep2D batch and rejects malformed draw content", () => {
    const displayList = { schemaVersion: 1 as const, id: "x.layer", revision: 1,
      logicalWidth: 320, logicalHeight: 180, scaleFactor: 1,
      resources: [{ kind: "path" as const, id: "shape", revision: 1,
        verbs: [{ op: "move" as const, x: 10, y: 10 }, { op: "line" as const, x: 80, y: 10 },
          { op: "line" as const, x: 45, y: 70 }, { op: "close" as const }] }],
      commands: [{ kind: "path" as const, id: "shape.paint", zOrder: 0, transform: [1, 0, 0, 1, 0, 0] as const,
        pathId: "shape", fill: [0.1, 0.7, 0.9, 1] as const }] };
    const frozen = freezeExperimentalXResource("x:display", 1, { ...request(), calls: [{ op: "emit-display-list", args: displayList }] });
    expect(frozen.payload.content.request.calls).toEqual([{ op: "emit-display-list", args: displayList }]);
    const compiled = buildExperimentalXRuntimePackage({ ...input(), packageId: "x.display",
      experimentalX: { id: "x:display", revision: 1, request: { ...request(), expectedEpoch: 9, startedAtMs: 200,
        randomSeed: 7, calls: [{ op: "emit-display-list", args: displayList }] } } });
    expect(compiled.packageJson).toBe(readFileSync(new URL("../../fixtures/experimental-x-display-runtime-v6.json", import.meta.url), "utf8").trim());
    expect(() => freezeExperimentalXResource("x:display", 1, { ...request(), calls: [
      { op: "emit-display-list", args: { ...displayList, commands: [{ ...displayList.commands[0]!, pathId: "missing" }] } },
    ] })).toThrow("missing");
    expect(() => freezeExperimentalXResource("x:display", 1, { ...request(), calls: [
      { op: "sequence", args: [{ op: "emit-display-list", args: displayList }, { op: "emit-display-list", args: displayList }] },
    ] })).toThrow("only one");
  });
  it("rejects unsafe integers, cycles, depth and message excess", () => {
    expect(() => freezeExperimentalXResource("x", 1, { ...request(), randomSeed: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => freezeExperimentalXResource("x", 1, { ...request(), calls: Array.from({ length: 1025 }, () => ({ op: "read-clock" as const })) })).toThrow();
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => freezeExperimentalXResource("x", 1, { ...request(), calls: cyclic } as never)).toThrow();
    for (const id of ["bad/path", "a".repeat(129)]) {
      expect(() => freezeExperimentalXResource("x", 1, { ...request(), resources: [{ id, bytes: [] }] })).toThrow();
    }
    let getterCalls = 0;
    const getter = Object.defineProperty(input(), "experimentalX", { enumerable: true, get() { getterCalls++; return {}; } });
    expect(() => buildExperimentalXRuntimePackage(getter)).toThrow("Accessors");
    expect(getterCalls).toBe(0);
  });
});
