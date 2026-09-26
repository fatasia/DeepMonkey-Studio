import { describe, expect, it } from "vitest";
import {
  buildHumanPercentileFigure,
  HUMAN_PERCENTILE_FIGURE_NOTE,
  HUMAN_PERCENTILE_RANKS,
  isHumanPercentileRank,
  isHumanSex,
  type HumanPercentileRank,
  type HumanSegmentKey,
  type HumanSex,
} from "./humanFigure.js";

describe("ANSUR-II percentile human figure generator (approximate, non-medical)", () => {
  it("produces the documented median values from the public stature statistics and classic ratios", () => {
    const male = buildHumanPercentileFigure(50, "male");
    expect(male.standard).toBe("ANSUR-II");
    expect(male.segmentLengthsMm.statureMm).toBe(1756);
    expect(male.segmentLengthsMm.shoulderHeightMm).toBe(Math.round(1756 * 0.818));
    expect(male.segmentLengthsMm.elbowHeightMm).toBe(Math.round(1756 * 0.63));
    expect(male.segmentLengthsMm.knuckleHeightMm).toBe(Math.round(1756 * 0.377));

    const female = buildHumanPercentileFigure(50, "female");
    expect(female.segmentLengthsMm.statureMm).toBe(1629);
    expect(female.segmentLengthsMm.shoulderHeightMm).toBe(Math.round(1629 * 0.818));
  });

  it("keeps z-table endpoints exact: P1 and P99 statures follow mean ± 2.3263·sd", () => {
    expect(buildHumanPercentileFigure(1, "male").segmentLengthsMm.statureMm).toBe(Math.round(1756 - 2.3263 * 67));
    expect(buildHumanPercentileFigure(99, "male").segmentLengthsMm.statureMm).toBe(Math.round(1756 + 2.3263 * 67));
    expect(buildHumanPercentileFigure(1, "female").segmentLengthsMm.statureMm).toBe(Math.round(1629 - 2.3263 * 64));
    expect(buildHumanPercentileFigure(99, "female").segmentLengthsMm.statureMm).toBe(Math.round(1629 + 2.3263 * 64));
  });

  it("is deterministic: identical calls produce identical segment tables", () => {
    expect(buildHumanPercentileFigure(95, "female")).toEqual(buildHumanPercentileFigure(95, "female"));
  });

  it("is monotonic across percentiles for every segment and both sexes (P1 < P5 < P50 < P95 < P99)", () => {
    const ranks: HumanPercentileRank[] = [...HUMAN_PERCENTILE_RANKS];
    for (const sex of ["male", "female"] as HumanSex[]) {
      const figures = ranks.map((rank) => buildHumanPercentileFigure(rank, sex));
      const segmentKeys = Object.keys(figures[0]!.segmentLengthsMm) as HumanSegmentKey[];
      for (const key of segmentKeys) {
        const values = figures.map((figure) => figure.segmentLengthsMm[key]!);
        for (let i = 1; i < values.length; i += 1) {
          expect(values[i]!).toBeGreaterThan(values[i - 1]!);
        }
      }
    }
  });

  it("keeps male figures larger than female figures at every percentile and segment", () => {
    for (const rank of HUMAN_PERCENTILE_RANKS) {
      const male = buildHumanPercentileFigure(rank, "male");
      const female = buildHumanPercentileFigure(rank, "female");
      for (const key of Object.keys(male.segmentLengthsMm) as HumanSegmentKey[]) {
        expect(male.segmentLengthsMm[key]!).toBeGreaterThan(female.segmentLengthsMm[key]!);
      }
    }
  });

  it("keeps the anatomical order shoulder > elbow > knuckle for every figure", () => {
    for (const rank of HUMAN_PERCENTILE_RANKS) {
      for (const sex of ["male", "female"] as HumanSex[]) {
        const { segmentLengthsMm } = buildHumanPercentileFigure(rank, sex);
        expect(segmentLengthsMm.shoulderHeightMm).toBeGreaterThan(segmentLengthsMm.elbowHeightMm);
        expect(segmentLengthsMm.elbowHeightMm).toBeGreaterThan(segmentLengthsMm.knuckleHeightMm);
      }
    }
  });

  it("rejects invalid ranks and sexes instead of guessing", () => {
    expect(() => buildHumanPercentileFigure(50.5, "male")).toThrow();
    expect(() => buildHumanPercentileFigure(90 as HumanPercentileRank, "male")).toThrow();
    expect(() => buildHumanPercentileFigure(50, "other" as HumanSex)).toThrow();
    expect(isHumanPercentileRank(5)).toBe(true);
    expect(isHumanPercentileRank(50.5)).toBe(false);
    expect(isHumanSex("female")).toBe(true);
    expect(isHumanSex("x")).toBe(false);
  });

  it("carries the approximate/non-medical disclaimer constant", () => {
    expect(HUMAN_PERCENTILE_FIGURE_NOTE).toContain("近似,非医学级");
  });
});
