import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDeep2dDisplayList } from "./deep2dDisplayList.js";

const GOLDEN_PATH = join(
  import.meta.dirname,
  "../../deep-engine-native/fixtures/deep2d_validator_golden_v1.json",
);

interface GoldenCase {
  readonly name: string;
  readonly displayList: Record<string, unknown>;
  readonly expectedValid: boolean;
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  cases: readonly GoldenCase[];
};

describe("Deep2d cross-language validator golden (TS side of the Rust twin)", () => {
  it("agrees with Rust decode/validate on every case", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(10);
    for (const testCase of golden.cases) {
      const result = validateDeep2dDisplayList(testCase.displayList).valid;
      expect(result, `case '${testCase.name}' diverged`).toBe(testCase.expectedValid);
    }
  });
});
