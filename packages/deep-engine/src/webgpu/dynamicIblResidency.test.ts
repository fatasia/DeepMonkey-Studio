import { describe, expect, it, vi } from "vitest";
import { DynamicIblResidency, classifyDynamicIblInvalidation, dynamicIblLeaseBytes,
  iblIdentity, planDynamicIblStage, type DynamicIblLease, type DynamicIblStagePlan,
  type RuntimePrefilteredIbl } from "./dynamicIblResidency.js";

/** sizes 4→2→1：specular 768+192+48=1008，diffuse(2) 192，LUT(2×2) 32，全量 1232。 */
const ibl = (overrides: Partial<{ id: string; revision: number; hash: string; lutSeed: string; lutWidth: number }> = {}):
  RuntimePrefilteredIbl => ({ schema: "deep-engine.ibl-prefiltered", schemaVersion: 1, kind: "prefiltered-hdri",
  format: "rgba16float", encoding: "base64-le", faceOrder: "px-nx-py-ny-pz-nz",
  id: overrides.id ?? "deep.test.ibl", revision: overrides.revision ?? 1,
  source: { contentHash: { algorithm: "sha256", value: overrides.hash ?? "a".repeat(64) }, license: "test-license" },
  specular: { mips: [4, 2, 1].map((size, level) => ({ size, dataBase64: `s${level}` })) },
  diffuse: { mips: [{ size: 2, dataBase64: "d" }] },
  brdfLut: { width: overrides.lutWidth ?? 2, height: overrides.lutWidth ?? 2, dataBase64: overrides.lutSeed ?? "L" } }) as RuntimePrefilteredIbl;

const plane = (bytes: number) => ({ bytes, dispose: vi.fn() });
const lease = (plan: DynamicIblStagePlan): DynamicIblLease =>
  ({ specular: plane(plan.specularBytes), diffuse: plane(plan.diffuseBytes), brdfLut: plane(plan.brdfLut.bytes) });
const RETIRED = [1008, 192]; // active 的 specular+diffuse（LUT 移交共享槽后世代只持这两平面）

function committedResidency(budget = 2 * 64 * 1024 * 1024) {
  const residency = new DynamicIblResidency(budget);
  const first = residency.plan(ibl());
  const staged = residency.stage(ibl(), lease(first));
  expect(staged.status).toBe("staged");
  expect(residency.commit(staged.generation!)).toBe(true);
  return { residency, first };
}

describe("I-C19 dynamic IBL invalidation triggers", () => {
  it("classifies the invalidation matrix: initial / unchanged / identity on any triple change", () => {
    const identity = iblIdentity(ibl());
    expect(classifyDynamicIblInvalidation(undefined, identity)).toBe("initial");
    expect(classifyDynamicIblInvalidation(identity, iblIdentity(ibl()))).toBe("unchanged");
    expect(classifyDynamicIblInvalidation(identity, iblIdentity(ibl({ id: "deep.test.other" })))).toBe("identity");
    expect(classifyDynamicIblInvalidation(identity, iblIdentity(ibl({ revision: 2 })))).toBe("identity");
    expect(classifyDynamicIblInvalidation(identity, iblIdentity(ibl({ hash: "b".repeat(64) })))).toBe("identity");
  });
  it("identity is exactly the triple, so light-only edits keep the IBL resident (explicit non-trigger)", () => {
    const identity = iblIdentity(ibl());
    expect(Object.keys(identity).sort()).toEqual(["contentHash", "id", "revision"]);
    // 作者改背景/雾/分级/光源不改 IBL 三元组 → unchanged；IBL 载荷变化必须由生产方推进 contentHash。
    expect(classifyDynamicIblInvalidation(identity, iblIdentity(ibl({ lutSeed: "changed-payload" })))).toBe("unchanged");
  });
  it("plans an unchanged package as idempotent without touching residency", () => {
    const { residency } = committedResidency();
    const plan = residency.plan(ibl());
    expect(plan.disposition).toBe("unchanged"); expect(plan.residencyBytes).toBe(0);
    const leases = lease(plan);
    expect(residency.stage(ibl(), leases)).toMatchObject({ status: "idempotent" });
    expect(leases.specular.dispose).toHaveBeenCalledOnce();
    expect(residency.activeGeneration).toBe(1);
  });
});

describe("I-C19 dynamic IBL budget decisions", () => {
  it("accepts a full chain when it fits and reuses an identical BRDF LUT across packages", () => {
    const { residency } = committedResidency();
    const next = ibl({ hash: "b".repeat(64) });
    const plan = residency.plan(next);
    expect(plan).toMatchObject({ invalidation: "identity", disposition: "accept", rawMips: 3, keptMips: 3,
      keptBaseSize: 4, specularBytes: 1008, diffuseBytes: 192 });
    expect(plan.brdfLut).toEqual({ action: "reuse", bytes: 0 });
    expect(plan.combinedBytes).toBe(1200 + 32 + 1200); // active(1008+192) + sharedLut(32) + candidate(1200)
    expect(plan.combinedBytes).toBeLessThanOrEqual(plan.budgetBytes);
  });
  it("degrades by trimming the chain head (rebased mip0) when the full chain busts the budget", () => {
    const { residency } = committedResidency(2000);
    const plan = residency.plan(ibl({ hash: "b".repeat(64) }));
    expect(plan.disposition).toBe("accept-degraded"); expect(plan.keptMips).toBe(2); expect(plan.keptBaseSize).toBe(2);
    expect(plan.specularBytes).toBe(192 + 48); expect(plan.combinedBytes).toBe(1200 + 32 + 432);
    const staged = residency.stage(ibl({ hash: "b".repeat(64) }), lease(plan));
    expect(staged.status).toBe("staged"); expect(residency.combinedResidencyBytes).toBe(1664);
  });
  it("rejects fail-closed and keeps the old generation when even a single mip busts the budget", () => {
    const { residency, first } = committedResidency(1300);
    const plan = residency.plan(ibl({ hash: "b".repeat(64) }));
    expect(plan).toMatchObject({ disposition: "rejected", keptMips: 0, keptBaseSize: 0, rejectReason: "budget" });
    expect(plan.combinedBytes).toBe(1232); // unchanged steady state
    const leases = lease(plan);
    expect(residency.stage(ibl({ hash: "b".repeat(64) }), leases)).toMatchObject({ status: "rejected" });
    for (const candidate of [leases.specular, leases.diffuse, leases.brdfLut]) expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(residency.activeGeneration).toBe(1);
    expect(residency.activeIdentity).toEqual(iblIdentity(ibl()));
    expect(first.specularBytes).toBe(1008);
  });
  it("accepts exactly at the budget boundary and degrades one mip below it", () => {
    const at = committedResidency(2432);
    expect(at.residency.plan(ibl({ hash: "b".repeat(64) })).disposition).toBe("accept");
    const below = committedResidency(2431);
    const plan = below.residency.plan(ibl({ hash: "b".repeat(64) }));
    expect(plan.disposition).toBe("accept-degraded"); expect(plan.keptMips).toBe(2);
    expect(plan.combinedBytes).toBeLessThanOrEqual(plan.budgetBytes);
  });
  it("reuses the LUT only on full byte equality, not on matching dimensions alone", () => {
    const { residency } = committedResidency();
    expect(residency.plan(ibl({ hash: "b".repeat(64), lutSeed: "M" })).brdfLut.action).toBe("upload");
    expect(residency.plan(ibl({ hash: "b".repeat(64), lutWidth: 4 })).brdfLut.action).toBe("upload");
    expect(residency.plan(ibl({ hash: "b".repeat(64) })).brdfLut.action).toBe("reuse");
  });
  it("validates constructor budgets and plan inputs", () => {
    expect(() => new DynamicIblResidency(0)).toThrow(TypeError);
    expect(() => new DynamicIblResidency(1.5)).toThrow(TypeError);
    expect(new DynamicIblResidency().budgetBytes).toBe(2 * 64 * 1024 * 1024);
    expect(() => planDynamicIblStage(undefined, undefined, {} as RuntimePrefilteredIbl, 1024)).toThrow(TypeError);
    expect(() => planDynamicIblStage(undefined, undefined,
      { ...ibl(), specular: { mips: [{ size: 0, dataBase64: "s" }] } } as RuntimePrefilteredIbl, 1024)).toThrow(TypeError);
  });
});

describe("I-C19 dynamic IBL reclamation sequencing", () => {
  it("retires the previous generation at commit and hands the LUT to the shared slot exactly once", () => {
    const { residency } = committedResidency();
    const before = residency.activeIdentity;
    const plan = residency.plan(ibl({ hash: "b".repeat(64), lutSeed: "M" }));
    const staged = residency.stage(ibl({ hash: "b".repeat(64), lutSeed: "M" }), lease(plan));
    expect(residency.pendingGeneration).toBe(2);
    expect(residency.commit(staged.generation!)).toBe(true);
    expect(residency.activeGeneration).toBe(2);
    expect(residency.outstandingLeases).toBe(2); // active + shared LUT
    expect(residency.activeIdentity).not.toEqual(before);
    expect(residency.sharedLutBytes).toBe(32);
  });
  it("keeps the shared LUT alive across a reuse swap and retires only specular/diffuse", () => {
    const { residency } = committedResidency();
    const plan = residency.plan(ibl({ hash: "b".repeat(64) }));
    const candidate = lease(plan);
    residency.stage(ibl({ hash: "b".repeat(64) }), candidate);
    residency.commit(2);
    expect(candidate.brdfLut.dispose).not.toHaveBeenCalled(); // reuse：共享 LUT 跨世代存活
    expect(candidate.specular.dispose).not.toHaveBeenCalled(); // 本世代成为 active
    expect(residency.sharedLutBytes).toBe(32);
  });
  it("rolls back a candidate, ignores stale commits, and supersedes a pending generation", () => {
    const { residency } = committedResidency();
    const superseded = lease(residency.plan(ibl({ hash: "b".repeat(64) })));
    const first = residency.stage(ibl({ hash: "b".repeat(64) }), superseded);
    const replacement = lease(residency.plan(ibl({ hash: "c".repeat(64) })));
    const second = residency.stage(ibl({ hash: "c".repeat(64) }), replacement);
    expect(first.generation).toBe(2); expect(second.generation).toBe(3);
    for (const candidate of [superseded.specular, superseded.diffuse, superseded.brdfLut]) expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(residency.commit(first.generation!)).toBe(false);
    expect(residency.rollback(second.generation!)).toBe(true);
    expect(residency.rollback(second.generation!)).toBe(false);
    for (const candidate of [replacement.specular, replacement.diffuse, replacement.brdfLut]) expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(residency.pendingGeneration).toBeUndefined(); expect(residency.activeGeneration).toBe(1);
    expect(residency.combinedResidencyBytes).toBe(1232);
  });
  it("leaks nothing through a hot-swap sequence and disposes every plane exactly once on dispose()", () => {
    const { residency } = committedResidency();
    const swap = lease(residency.plan(ibl({ hash: "b".repeat(64), lutSeed: "M" })));
    const staged = residency.stage(ibl({ hash: "b".repeat(64), lutSeed: "M" }), swap);
    residency.commit(staged.generation!);
    const back = lease(residency.plan(ibl()));
    const revert = residency.stage(ibl(), back);
    residency.commit(revert.generation!);
    expect(residency.combinedResidencyBytes).toBeLessThanOrEqual(residency.budgetBytes);
    residency.dispose();
    for (const candidate of [swap.specular, swap.diffuse, swap.brdfLut, back.specular, back.diffuse, back.brdfLut]) {
      expect(candidate.dispose).toHaveBeenCalledOnce();
    }
    residency.dispose(); // 幂等
    expect(() => residency.plan(ibl())).toThrow("disposed");
    expect(() => residency.stage(ibl(), { specular: plane(1), diffuse: plane(1), brdfLut: plane(1) }))
      .toThrow("disposed");
  });
  it("aggregates plane retirement failures and still releases the remaining planes", () => {
    const { residency } = committedResidency();
    const swap = lease(residency.plan(ibl({ hash: "b".repeat(64), lutSeed: "M" })));
    (swap.diffuse.dispose as ReturnType<typeof vi.fn>).mockImplementation(() => { throw Error("plane stuck"); });
    const staged = residency.stage(ibl({ hash: "b".repeat(64), lutSeed: "M" }), swap);
    residency.commit(staged.generation!);
    expect(() => residency.dispose()).toThrow(AggregateError);
    expect(swap.specular.dispose).toHaveBeenCalledOnce();
    expect(swap.brdfLut.dispose).toHaveBeenCalledOnce(); // 共享槽回收
    expect(residency.disposed).toBe(true);
  });
  it("fails closed on lease bytes that differ from the plan and on malformed leases", () => {
    const { residency } = committedResidency();
    const plan = residency.plan(ibl({ hash: "b".repeat(64) }));
    const wrong = { specular: plane(plan.specularBytes + 8), diffuse: plane(plan.diffuseBytes), brdfLut: plane(0) };
    expect(() => residency.stage(ibl({ hash: "b".repeat(64) }), wrong)).toThrow(TypeError);
    expect(wrong.specular.dispose).toHaveBeenCalledOnce();
    expect(residency.pendingGeneration).toBeUndefined();
    expect(() => residency.stage(ibl({ hash: "b".repeat(64) }),
      { specular: plane(1), diffuse: plane(plan.diffuseBytes), brdfLut: plane(0) })).toThrow(TypeError);
    expect(() => residency.stage(ibl({ hash: "b".repeat(64) }),
      { ...lease(plan), specular: { bytes: 1, dispose: undefined as never } })).toThrow(TypeError);
    expect(dynamicIblLeaseBytes({ specular: plane(8), diffuse: plane(4), brdfLut: plane(2) })).toBe(14);
  });
});
