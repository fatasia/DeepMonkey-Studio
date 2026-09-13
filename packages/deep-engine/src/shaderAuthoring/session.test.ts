import { describe, expect, it } from "vitest";
import { createShaderAuthoringSession, restoreShaderAuthoringSession } from "./session.js";
import { graphDocument, TEST_CAPABILITIES, testArtifact, textDocument } from "./testFixture.js";
import type { ShaderAuthoringCompilerResult } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function success(): ShaderAuthoringCompilerResult {
  return { success: true, diagnostics: [], artifact: testArtifact() };
}

describe("ShaderAuthoringSession", () => {
  it("creates a stable revision and promotes a graph compile candidate", async () => {
    const first = createShaderAuthoringSession(graphDocument(), { capabilities: TEST_CAPABILITIES });
    const reordered = createShaderAuthoringSession({
      mode: "graph",
      passId: "forward",
      asset: graphDocument().asset,
      id: "authoring.graph",
      techniqueId: "webgpu",
      schemaVersion: 1,
    }, { capabilities: TEST_CAPABILITIES });
    expect(first.success).toBe(true);
    expect(first.session!.view().revision).toBe(reordered.session!.view().revision);

    const commit = await first.session!.compileCandidate();
    expect(commit).toMatchObject({ committed: true, stale: false });
    expect(commit.result.success).toBe(true);
    expect(commit.view.compile.status).toBe("succeeded");
    expect(commit.view.lastKnownGood?.artifact.pass.module.code).toContain("@vertex fn deepVertex");
    expect(commit.view.lastKnownGood?.artifact.sourceMap[0]).toMatchObject({
      sourceKind: "graph-node",
      stage: "vertex",
      nodeId: "position",
    });
  });

  it("stores DeepSL text without pretending a parser exists", async () => {
    const result = createShaderAuthoringSession(textDocument());
    expect(result.success).toBe(true);
    expect(result.session!.view().document).toMatchObject({ mode: "text", language: "deepsl" });
    const compile = await result.session!.compileCandidate();
    expect(compile.result.success).toBe(false);
    expect(compile.result.diagnostics[0]).toMatchObject({ code: "compiler-unavailable", source: "session" });
    expect(compile.view.lastKnownGood).toBeUndefined();
  });

  it("keeps the last-known-good artifact when a later revision fails", async () => {
    const created = createShaderAuthoringSession(graphDocument(), { capabilities: TEST_CAPABILITIES });
    const good = await created.session!.compileCandidate();
    const goodKey = good.view.lastKnownGood!.artifact.pass.cacheKey;
    created.session!.replaceDocument(textDocument("broken"));
    const failed = await created.session!.compileCandidate();
    expect(failed.result.success).toBe(false);
    expect(failed.view.lastKnownGood?.artifact.pass.cacheKey).toBe(goodKey);
    expect(failed.view.lastKnownGood?.revision).toBe(good.revision);
  });

  it("prevents stale async results from overwriting a new revision", async () => {
    const oldResult = deferred<ShaderAuthoringCompilerResult>();
    const newResult = deferred<ShaderAuthoringCompilerResult>();
    const calls: Array<typeof oldResult> = [oldResult, newResult];
    const created = createShaderAuthoringSession(textDocument("old"), {
      textCompiler: () => calls.shift()!.promise,
    });
    const oldCompile = created.session!.compileCandidate();
    created.session!.replaceDocument(textDocument("new"));
    const newCompile = created.session!.compileCandidate();
    oldResult.resolve(success());
    const stale = await oldCompile;
    expect(stale).toMatchObject({ committed: false, stale: true });
    expect(created.session!.view().compile.status).toBe("compiling");
    expect(created.session!.view().lastKnownGood).toBeUndefined();

    newResult.resolve(success());
    const promoted = await newCompile;
    expect(promoted).toMatchObject({ committed: true, stale: false });
    expect(promoted.view.lastKnownGood?.revision).toBe(promoted.revision);
  });

  it("also makes an older request stale when two compiles target one revision", async () => {
    const older = deferred<ShaderAuthoringCompilerResult>();
    const newer = deferred<ShaderAuthoringCompilerResult>();
    const queue = [older, newer];
    const created = createShaderAuthoringSession(textDocument(), { textCompiler: () => queue.shift()!.promise });
    const first = created.session!.compileCandidate();
    const second = created.session!.compileCandidate();
    newer.resolve(success());
    expect((await second).committed).toBe(true);
    const promotedId = created.session!.view().lastKnownGood?.candidateId;
    older.resolve({ success: false, diagnostics: [{ severity: "error", source: "text-compiler", code: "late", path: "$", message: "late" }] });
    expect((await first).stale).toBe(true);
    expect(created.session!.view().lastKnownGood?.candidateId).toBe(promotedId);
    expect(created.session!.view().compile.status).toBe("succeeded");
  });

  it("bounds undo/redo, restores stable revisions, and clears redo after an edit", () => {
    const created = createShaderAuthoringSession(textDocument("0"), { historyLimit: 2 });
    const initialRevision = created.session!.view().revision;
    created.session!.replaceDocument(textDocument("1"));
    created.session!.replaceDocument(textDocument("2"));
    created.session!.replaceDocument(textDocument("3"));
    expect(created.session!.undo()).toBe(true);
    expect((created.session!.view().document as { source: string }).source).toBe("2");
    expect(created.session!.undo()).toBe(true);
    expect((created.session!.view().document as { source: string }).source).toBe("1");
    expect(created.session!.undo()).toBe(false);
    expect(created.session!.view().revision).not.toBe(initialRevision);
    expect(created.session!.redo()).toBe(true);
    created.session!.replaceDocument(textDocument("branch"));
    expect(created.session!.view().canRedo).toBe(false);
  });

  it("serializes deterministic content history and restores with volatile compile state reset", async () => {
    const created = createShaderAuthoringSession(graphDocument(), { capabilities: TEST_CAPABILITIES });
    await created.session!.compileCandidate();
    created.session!.replaceDocument(textDocument("draft"));
    const serialized = created.session!.serialize();
    const restored = restoreShaderAuthoringSession(serialized);
    expect(restored.success).toBe(true);
    expect(restored.session!.serialize()).toBe(serialized);
    expect(restored.session!.view()).toMatchObject({ canUndo: true, compile: { status: "idle" } });
    expect(restored.session!.view().lastKnownGood).toBeUndefined();
  });

  it("rejects invalid edits transactionally and normalizes compiler failures", async () => {
    const created = createShaderAuthoringSession(textDocument("safe"), {
      textCompiler: () => { throw new Error("secret implementation detail"); },
    });
    const before = created.session!.view();
    const edit = created.session!.replaceDocument({ ...textDocument(), extra: true });
    expect(edit).toMatchObject({ accepted: false, changed: false });
    expect(edit.diagnostics[0]?.code).toBe("unknown-field");
    expect(edit.view.revision).toBe(before.revision);
    const compile = await created.session!.compileCandidate();
    expect(compile.result.diagnostics[0]).toMatchObject({ code: "compiler-threw" });
    expect(compile.result.diagnostics[0]?.message).not.toContain("secret");
  });

  it("fails closed on contradictory or accessor-backed compiler results", async () => {
    const contradictory = createShaderAuthoringSession(textDocument(), {
      textCompiler: () => ({
        success: true,
        diagnostics: [{ severity: "error", source: "text-compiler", code: "parse", path: "$.source", message: "bad" }],
        artifact: testArtifact(),
      }),
    });
    const invalid = await contradictory.session!.compileCandidate();
    expect(invalid.result).toMatchObject({ success: false });
    expect(invalid.result.diagnostics[0]?.code).toBe("invalid-compiler-result");
    expect(invalid.view.lastKnownGood).toBeUndefined();

    let reads = 0;
    const poisoned: Record<string, unknown> = { success: true, diagnostics: [] };
    Object.defineProperty(poisoned, "artifact", {
      enumerable: true,
      get: () => { reads += 1; return testArtifact(); },
    });
    const accessor = createShaderAuthoringSession(textDocument(), {
      textCompiler: () => poisoned as unknown as ShaderAuthoringCompilerResult,
    });
    const rejected = await accessor.session!.compileCandidate();
    expect(rejected.result.diagnostics[0]?.code).toBe("invalid-compiler-result");
    expect(reads).toBe(0);
  });
});
