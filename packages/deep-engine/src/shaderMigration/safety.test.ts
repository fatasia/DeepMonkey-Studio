import { describe, expect, it } from "vitest";
import { SHADER_MIGRATION_MAX_DIAGNOSTICS } from "./constants.js";
import { evaluateShaderMigration } from "./evaluator.js";
import { profile, requirement } from "./testFixtures.js";

describe("shader migration input hardening", () => {
  it("fails closed on unknown profile, facet, and requirement fields", () => {
    const input = profile();
    const result = evaluateShaderMigration(
      { ...input, future: true, facets: { ...input.facets, properties: { ...input.facets.properties, future: true } } },
      { ...requirement(), future: true },
    );
    expect(result).toMatchObject({ valid: false, eligible: false, strategy: "rejected" });
    expect(result.diagnostics.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "$.profile.future", "$.profile.facets.properties.future", "$.requirement.future",
    ]));
  });

  it("rejects absent, duplicate, and non-canonical evidence ids", () => {
    const input = profile();
    const result = evaluateShaderMigration({
      ...input,
      facets: {
        ...input.facets,
        properties: { status: "verified", evidenceIds: [], reason: null },
        passes: { status: "verified", evidenceIds: ["z", "a", "a"], reason: null },
      },
    }, requirement());
    expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "MISSING_EVIDENCE", "NON_CANONICAL_EVIDENCE",
    ]));
    expect(result).toMatchObject({ valid: false, eligible: false, strategy: "rejected" });
  });

  it("does not execute getters", () => {
    let executions = 0;
    const hostile = profile() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "sourceKind", {
      enumerable: true,
      get() {
        executions += 1;
        return "unity-standard";
      },
    });
    expect(() => evaluateShaderMigration(hostile, requirement())).not.toThrow();
    expect(executions).toBe(0);
    expect(evaluateShaderMigration(hostile, requirement()).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ACCESSOR" })]),
    );
  });

  it("rejects cycles, repeated references, sparse arrays, and throwing proxies without exceptions", () => {
    const cycle: Record<string, unknown> = { ...profile() };
    cycle.cycle = cycle;
    const shared: Record<string, unknown> = { value: true };
    const aliased = { ...profile(), first: shared, second: shared };
    const sparse = requirement();
    const sparseFacets = new Array(2);
    sparseFacets[1] = "properties";
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    for (const value of [
      evaluateShaderMigration(cycle, requirement()),
      evaluateShaderMigration(aliased, requirement()),
      evaluateShaderMigration(profile(), { ...sparse, requiredFacets: sparseFacets }),
      evaluateShaderMigration(proxy, requirement()),
    ]) {
      expect(value).toMatchObject({ valid: false, eligible: false, strategy: "rejected" });
    }
  });

  it("caps diagnostics and terminates oversized data inspection", () => {
    const unknown = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`unknown${index}`, true]));
    const capped = evaluateShaderMigration({ ...profile(), ...unknown }, requirement());
    expect(capped.diagnostics).toHaveLength(SHADER_MIGRATION_MAX_DIAGNOSTICS);
    expect(capped.diagnostics.at(-1)?.code).toBe("DIAGNOSTIC_LIMIT");

    const bomb = Array.from({ length: 512 }, () => [0, 1, 2, 3, 4]);
    const budgeted = evaluateShaderMigration({ ...profile(), bomb }, requirement());
    expect(budgeted.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NODE_BUDGET" })]));
  });

  it("returns identical results for equivalent insertion orders", () => {
    const original = profile("three-tsl");
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    const first = evaluateShaderMigration(original, requirement());
    const second = evaluateShaderMigration(reversed, { ...requirement() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
