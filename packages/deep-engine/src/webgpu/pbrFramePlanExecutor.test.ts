import { describe, expect, it } from "vitest";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { ambientOcclusionHalfSize } from "../postprocess/ambientOcclusion.js";
import { surfaceSize } from "./surfaceSize.js";
import { validateSampleWindow } from "../benchmarkSampleSchema.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual,
  createPbrFrameReceipt, createPbrPassTimingSample, createPbrPassUnavailableSample,
  pbrReceiptSampleWindow, type PbrFrameExecutionPlan } from "./pbrFramePlanExecutor.js";
import { resolvePbrFramePlanSurface, resolvePbrFrameResourceSizes } from "./pbrFramePlanResources.js";
import type { PbrActualPassDescription } from "./pbrFramePlanResources.js";

const SURFACE = Object.freeze({ width: 1920, height: 1080 });
const plan = (transparency: boolean, surface: { width: number; height: number } = SURFACE): PbrFrameExecutionPlan =>
  buildPbrFrameExecutionPlan(surface, { transparency });

describe("pbr frame execution plan", () => {
  it("maps the AO→TAA→Bloom subchain and explicit unmapped passes in both transparency modes", () => {
    for (const transparency of [false, true]) {
      const subject = plan(transparency);
      const byId = new Map(subject.passes.map(pass => [pass.passId, pass]));
      for (const passId of ["ambient-occlusion", "apply-ambient-occlusion", "temporal-aa", "bloom", "present", "opaque"]) {
        expect(byId.get(passId)!.mapping).toMatchObject({ status: "mapped" });
        expect((byId.get(passId)!.mapping as { executor: string }).executor.length).toBeGreaterThan(0);
      }
      expect(subject.unmappedPassIds).toEqual(["deform", "visibility", "shadows", "cluster-lights", "build-hiz", "publish-hiz"]);
      for (const passId of subject.unmappedPassIds) {
        expect((byId.get(passId)!.mapping as { reason: string }).reason).toBeTruthy();
      }
      expect(subject.passOrder).toEqual([...byId.keys()]);
    }
  });

  it("switches the temporal input and OIT passes with the transparency switch", () => {
    const off = plan(false), on = plan(true);
    expect(off.passes.map(pass => pass.passId)).not.toContain("transparent-oit");
    expect(on.passes.map(pass => pass.passId)).toEqual(
      expect.arrayContaining(["transparent-oit", "composite-oit"]));
    const taaReads = (subject: PbrFrameExecutionPlan): readonly string[] =>
      subject.passes.find(pass => pass.passId === "temporal-aa")!.reads;
    expect(taaReads(off)).toEqual(["ao-hdr", "linear-depth", "motion"]);
    expect(taaReads(on)).toEqual(["composited-hdr", "linear-depth", "motion"]);
    const resourceIds = (subject: PbrFrameExecutionPlan): readonly string[] => subject.resourceLifetimes.map(entry => entry.id);
    expect(resourceIds(on)).toEqual(expect.arrayContaining(["oit-accumulation", "oit-revealage", "composited-hdr"]));
    expect(resourceIds(off)).not.toContain("oit-accumulation");
  });

  it("annotates external/history lifecycle from the compiled plan", () => {
    const subject = plan(true);
    const byId = new Map(subject.resourceLifetimes.map(entry => [entry.id, entry]));
    expect(byId.get("surface")).toMatchObject({ external: true });
    expect(byId.get("next-hiz")).toMatchObject({ external: true, historyRole: "next" });
    expect(byId.get("previous-hiz")).toMatchObject({ external: true, historyRole: "previous" });
    expect(byId.get("opaque-hdr")).toMatchObject({ external: false, transientSlot: expect.any(Number) });
    expect(byId.get("animation-state")).toMatchObject({ external: true });
    expect(byId.get("animation-state")!.transientSlot).toBeUndefined();
  });

  it("expands per-pass resource declarations with format, sample count, usage and size", () => {
    const subject = plan(false);
    const opaque = subject.passes.find(pass => pass.passId === "opaque")!;
    const hdrWrite = opaque.resources.find(resource => resource.id === "opaque-hdr")!;
    expect(hdrWrite).toMatchObject({ access: "write", format: "rgba16float", sampleCount: 1,
      sizeRole: "surface", width: SURFACE.width, height: SURFACE.height });
    expect(hdrWrite.usages).toEqual(expect.arrayContaining(["render-attachment", "texture-binding"]));
    const ao = subject.passes.find(pass => pass.passId === "ambient-occlusion")!;
    const aoHalf = ao.resources.find(resource => resource.id === "ao-half")!;
    expect(aoHalf).toMatchObject({ access: "write", format: "r32float", sizeRole: "half",
      width: SURFACE.width / 2, height: SURFACE.height / 2 });
  });
});

describe("plan vs actual pass matching", () => {
  it("matches the actual descriptions in both transparency combinations with default features", () => {
    for (const transparency of [false, true]) {
      const subject = plan(transparency);
      const actual = collectActualPbrFramePasses(DEFAULT_PBR_RENDERER_FEATURES, transparency);
      const diff = assertPlanMatchesActual(subject, actual);
      expect(diff.mismatches).toEqual([]);
      const planOnly = new Map(diff.planOnlyReads.map(entry => [entry.passId, entry.resources]));
      expect(planOnly.get("opaque")).toEqual(["visible-draws", "shadow-atlas", "light-grid"]);
      if (transparency) {
        expect(planOnly.get("transparent-oit")).toEqual(["visible-draws", "linear-depth", "shadow-atlas", "light-grid"]);
      } else {
        expect(planOnly.has("transparent-oit")).toBe(false);
      }
    }
  });

  it("fails with the differing field when an actual format drifts", () => {
    const subject = plan(false);
    const actual = collectActualPbrFramePasses(DEFAULT_PBR_RENDERER_FEATURES, false).map(description =>
      description.passId !== "bloom" ? description : {
        ...description, claims: description.claims.map(claim =>
          claim.id !== "bloom-hdr" ? claim : { ...claim, format: "rgba8unorm" }),
      });
    expect(() => assertPlanMatchesActual(subject, actual)).toThrow("resources.bloom-hdr.format");
  });

  it("fails on a missing write and on an undeclared read", () => {
    const subject = plan(true);
    const actual = collectActualPbrFramePasses(DEFAULT_PBR_RENDERER_FEATURES, true).map(description =>
      description.passId !== "opaque" ? description : { ...description, writes: description.writes.filter(id => id !== "motion") });
    expect(() => assertPlanMatchesActual(subject, actual)).toThrow("opaque.writes");

    const sneaky = collectActualPbrFramePasses(DEFAULT_PBR_RENDERER_FEATURES, true).map(description =>
      description.passId !== "temporal-aa" ? description : { ...description, reads: [...description.reads, "next-hiz"] });
    const issues: string[] = [];
    try { assertPlanMatchesActual(subject, sneaky); } catch (error) { issues.push((error as Error).message); }
    expect(issues[0]).toContain("temporal-aa.reads");
    expect(issues[0]).toContain("next-hiz");
  });

  it("reports every plan pass that loses its actual description when features disable it", () => {
    const subject = plan(false);
    const actual = collectActualPbrFramePasses(resolvePbrRendererFeatures({ ambientOcclusion: false }), false);
    try { assertPlanMatchesActual(subject, actual); throw new Error("expected mismatch"); }
    catch (error) { expect((error as Error).message).toContain("actual-description"); }
  });

  it("rejects actual passes that do not exist in the plan", () => {
    const subject = plan(false);
    const phantom: PbrActualPassDescription = {
      passId: "phantom-pass", executor: "does not exist", kind: "compute",
      reads: [], writes: [], claims: [],
    };
    expect(() => assertPlanMatchesActual(subject, [...collectActualPbrFramePasses(DEFAULT_PBR_RENDERER_FEATURES, false), phantom]))
      .toThrow("pass-id");
  });
});

describe("resize size derivation", () => {
  it("derives the plan surface exactly like the render-target surfaceSize source", () => {
    const cases = [
      { width: 1920, height: 1080, ratio: 1, limit: 8192 },
      { width: 1280, height: 720, ratio: 2, limit: 4096 },
      { width: 5000, height: 5000, ratio: 3, limit: 4096 },
      { width: 0, height: 100, ratio: 1, limit: 4096 },
    ];
    for (const input of cases) {
      expect(resolvePbrFramePlanSurface(input.width, input.height, input.ratio, input.limit))
        .toEqual(surfaceSize(input.width, input.height, input.ratio, input.limit));
    }
  });

  it("resolves full and half resource sizes deterministically, matching the real AO derivation", () => {
    const first = resolvePbrFrameResourceSizes(SURFACE), second = resolvePbrFrameResourceSizes(SURFACE);
    expect(first).not.toBe(second);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get("opaque-hdr")).toEqual(SURFACE);
    expect(first.get("temporal-hdr")).toEqual(SURFACE);
    expect(first.get("ao-half")).toEqual({ width: 960, height: 540 });
    const odd = resolvePbrFrameResourceSizes({ width: 1081, height: 721 });
    expect(odd.get("ao-half")).toEqual({ width: 541, height: 361 });
    expect(odd.get("ao-half")).toEqual({
      width: ambientOcclusionHalfSize(1081, 721)[0], height: ambientOcclusionHalfSize(1081, 721)[1],
    });
  });

  it("rescales every planned size when the surface resizes", () => {
    const small = plan(false, { width: 640, height: 360 });
    const opaque = small.passes.find(pass => pass.passId === "opaque")!;
    const surfaceWrites = opaque.resources.filter(resource => resource.sizeRole === "surface");
    expect(surfaceWrites.length).toBe(4);
    for (const resource of surfaceWrites) {
      expect(resource).toMatchObject({ width: 640, height: 360 });
    }
    expect(opaque.resources.filter(resource => resource.sizeRole === "independent").map(resource => resource.id))
      .toEqual(["visible-draws", "shadow-atlas", "light-grid"]);
    expect("width" in opaque.resources.find(resource => resource.id === "visible-draws")!).toBe(false);
    const aoHalf = small.passes.find(pass => pass.passId === "ambient-occlusion")!
      .resources.find(resource => resource.id === "ao-half")!;
    expect(aoHalf).toMatchObject({ width: 320, height: 180 });
    expect(small.resourceLifetimes.length).toEqual(plan(false).resourceLifetimes.length);
  });
});

describe("pass execution receipt", () => {
  it("records per-pass gpu-timestamp channels and keeps unmapped passes explicitly unavailable", () => {
    const subject = plan(true);
    const timings = subject.mappedPassIds.map((passId, index) => ({ passId, durationMs: 0.25 * (index + 1) }));
    const receipt = createPbrFrameReceipt(7, subject, timings, 100, 116);
    expect(receipt.samples.length).toBe(subject.passOrder.length);
    const byChannel = new Map(receipt.samples.map(sample => [sample.passChannel, sample]));
    expect(byChannel.get("gpu-timestamp.pass.bloom")).toMatchObject({ availability: "measured", sampleCount: 1 });
    expect(byChannel.get("gpu-timestamp.pass.deform")).toMatchObject({ availability: "unavailable" });
    expect(byChannel.get("gpu-timestamp.pass.deform")!.unavailableReason).toContain("第一切片");
    expect(byChannel.get("gpu-timestamp.pass.deform")!.samplesMs).toEqual([]);
  });

  it("validates every pass channel and the aggregated window against the A03 schema", () => {
    const subject = plan(false);
    const timings = subject.mappedPassIds.map(passId => ({ passId, durationMs: 1.5 }));
    const receipt = createPbrFrameReceipt(3, subject, timings, 0, 16);
    for (const sample of receipt.samples) {
      const issues = validateSampleWindow({
        schema: "deep-engine.benchmark-sample-window", schemaVersion: 1, runId: "per-pass", clockId: "gpu-timestamp",
        windowStartMs: 0, windowEndMs: 16, channels: [sample],
      });
      expect(issues).toEqual([]);
    }
    const window = pbrReceiptSampleWindow(receipt, "run-1");
    expect(validateSampleWindow(window)).toEqual([]);
    const timestampChannel = window.channels.find(channel => channel.channel === "gpu-timestamp")!;
    expect(timestampChannel.sampleCount).toBe(subject.mappedPassIds.length);
    expect(timestampChannel.availability).toBe("measured");
  });

  it("aggregates to an explicitly unavailable window when no pass was measured", () => {
    const subject = plan(false);
    const receipt = createPbrFrameReceipt(1, subject, [], 0, 16);
    const window = pbrReceiptSampleWindow(receipt, "run-2");
    expect(validateSampleWindow(window)).toEqual([]);
    const channel = window.channels.find(entry => entry.channel === "gpu-timestamp")!;
    expect(channel).toMatchObject({ availability: "unavailable", sampleCount: 0 });
    expect(channel.unavailableReason).toContain("gpu-timestamp.pass.deform");
  });

  it("rejects duplicate or out-of-plan timings and invalid durations", () => {
    const subject = plan(false);
    const timings = subject.mappedPassIds.map(passId => ({ passId, durationMs: 1 }));
    expect(() => createPbrFrameReceipt(1, subject, [...timings, timings[0]!], 0, 16)).toThrow("Duplicate");
    expect(() => createPbrFrameReceipt(1, subject, [...timings, { passId: "nope", durationMs: 1 }], 0, 16)).toThrow("not in the plan");
    expect(() => createPbrPassTimingSample("bloom", -1, 0, 16)).toThrow("non-negative");
    expect(() => createPbrPassUnavailableSample("bloom", "  ", 0, 16)).toThrow("reason");
    expect(() => createPbrPassTimingSample("bloom", 1, 16, 16)).toThrow("window bounds");
  });
});
