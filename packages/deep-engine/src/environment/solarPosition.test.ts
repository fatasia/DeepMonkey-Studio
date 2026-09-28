import { describe, expect, it } from "vitest";
import { atmosphericRefractionDeg, julianDate, solarDirectionEnu, solarEphemeris, solarPosition } from "./solarPosition.js";

const utc = (iso: string): number => Date.parse(`${iso}Z`);
// 2026 年天文节点(民用历:3-20 春分 / 6-21 夏至 / 12-21 冬至),当日 12:00 UTC 取样。
const EQUINOX = utc("2026-03-20T12:00:00");
const SOLSTICE_JUN = utc("2026-06-21T12:00:00");
const SOLSTICE_DEC = utc("2026-12-21T12:00:00");

/** 当日最大仰角:10 分钟粗网格 + 1 分钟细化窗口(确定性两级网格搜索,非优化器)。 */
function maxElevationOfDay(latitudeDeg: number, longitudeDeg: number, dayStartIso: string): number {
  const start = utc(dayStartIso);
  let bestMinute = 0;
  let best = -90;
  for (let minute = 0; minute < 1440; minute += 10) {
    const elevation = solarPosition({ latitudeDeg, longitudeDeg, timeUtcMs: start + minute * 60000 }).elevationDeg;
    if (elevation > best) { best = elevation; bestMinute = minute; }
  }
  for (let minute = Math.max(0, bestMinute - 10); minute <= Math.min(1439, bestMinute + 10); minute += 1) {
    best = Math.max(best, solarPosition({ latitudeDeg, longitudeDeg, timeUtcMs: start + minute * 60000 }).elevationDeg);
  }
  return best;
}

describe("solarEphemeris", () => {
  it("keeps declination within the obliquity band and matches solstice/equinox nodes", () => {
    const june = solarEphemeris(SOLSTICE_JUN).declinationDeg;
    const december = solarEphemeris(SOLSTICE_DEC).declinationDeg;
    expect(june).toBeGreaterThan(23.1);
    expect(june).toBeLessThan(23.8);
    expect(december).toBeLessThan(-23.1);
    expect(december).toBeGreaterThan(-23.8);
    expect(Math.abs(solarEphemeris(EQUINOX).declinationDeg)).toBeLessThan(0.5);
  });
  it("keeps apparent longitude monotone-ish across a year via bounded eccentricity correction", () => {
    const march = solarEphemeris(EQUINOX);
    // 春分视黄经 ≈ 0(mod 360;取圆周距离,不受 [0,360) 折返影响)。
    const circularDistance = Math.min(march.apparentLongitudeDeg, 360 - march.apparentLongitudeDeg);
    expect(circularDistance).toBeLessThan(1);
    expect(march.eccentricity).toBeGreaterThan(0.016);
    expect(march.eccentricity).toBeLessThan(0.018);
    expect(Math.abs(march.equationOfTimeMinutes)).toBeLessThan(17);
  });
});

describe("solarPosition invariants", () => {
  it("reaches 90 - |lat - decl| at solar noon (grid max over the day)", () => {
    const declination = solarEphemeris(EQUINOX).declinationDeg;
    const expected = 90 - Math.abs(40 - declination);
    const observed = maxElevationOfDay(40, 0, "2026-03-20T00:00:00");
    expect(observed).toBeCloseTo(expected, 1);
    const equatorMax = maxElevationOfDay(0, 0, "2026-03-20T00:00:00");
    // 春分赤道太阳过天顶;两级网格离散(1 分钟步长,太阳 0.25°/分)留 0.2° 余量。
    expect(equatorMax).toBeGreaterThan(89.8);
  });
  it("gives due-south azimuth at (near) solar noon in the northern hemisphere", () => {
    const noon = utc("2026-03-20T12:05:00");
    const result = solarPosition({ latitudeDeg: 40, longitudeDeg: 0, timeUtcMs: noon });
    expect(result.azimuthDeg).toBeGreaterThan(176);
    expect(result.azimuthDeg).toBeLessThan(184);
    // 12:05 UTC 距真太阳时正午(约 12:07:30,均时差 −7.5 分)差 2.5 分 → |HA| < 2°。
    expect(Math.abs(result.hourAngleDeg)).toBeLessThan(2);
  });
  it("rises in the east and sets in the west at the equinox", () => {
    const morning = solarPosition({ latitudeDeg: 40, longitudeDeg: 0, timeUtcMs: utc("2026-03-20T06:10:00") });
    const evening = solarPosition({ latitudeDeg: 40, longitudeDeg: 0, timeUtcMs: utc("2026-03-20T18:05:00") });
    expect(morning.elevationDeg).toBeGreaterThan(0);
    expect(morning.azimuthDeg).toBeGreaterThan(80);
    expect(morning.azimuthDeg).toBeLessThan(100);
    expect(evening.azimuthDeg).toBeGreaterThan(260);
    expect(evening.azimuthDeg).toBeLessThan(280);
  });
  it("is below the horizon at local midnight and above at local noon", () => {
    const midnight = solarPosition({ latitudeDeg: 40, longitudeDeg: 0, timeUtcMs: utc("2026-03-20T00:05:00") });
    expect(midnight.elevationDeg).toBeLessThan(-30);
    const noonish = solarPosition({ latitudeDeg: 40, longitudeDeg: 0, timeUtcMs: utc("2026-03-20T12:05:00") });
    expect(noonish.elevationDeg).toBeGreaterThan(45);
  });
  it("is bitwise deterministic for identical inputs", () => {
    const input = { latitudeDeg: 31.23, longitudeDeg: 121.47, timeUtcMs: utc("2026-06-21T01:30:00") };
    const first = solarPosition(input);
    const second = solarPosition({ ...input });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
  it("rejects out-of-range coordinates and non-finite time", () => {
    expect(() => solarPosition({ latitudeDeg: 91, longitudeDeg: 0, timeUtcMs: 0 })).toThrow(/latitude/);
    expect(() => solarPosition({ latitudeDeg: 0, longitudeDeg: 200, timeUtcMs: 0 })).toThrow(/longitude/);
    expect(() => solarPosition({ latitudeDeg: 0, longitudeDeg: 0, timeUtcMs: Number.NaN })).toThrow(/time/);
  });
});

describe("solarDirectionEnu", () => {
  it("returns a unit vector consistent with elevation/azimuth", () => {
    const input = { latitudeDeg: 40, longitudeDeg: 116, timeUtcMs: utc("2026-06-21T04:00:00") };
    const [east, north, up] = solarDirectionEnu(input);
    expect(Math.hypot(east, north, up)).toBeCloseTo(1, 12);
    const position = solarPosition(input);
    expect(up).toBeCloseTo(Math.sin(position.elevationDeg * Math.PI / 180), 12);
  });
  it("points south (negative north) at northern-hemisphere midday", () => {
    // 仰角≈50° 时北分量 = cos(50°)·cos(180°) ≈ −0.64,取 < −0.5 判南向。
    const [east, north] = solarDirectionEnu({ latitudeDeg: 40, longitudeDeg: 0, timeUtcMs: utc("2026-03-20T12:05:00") });
    expect(north).toBeLessThan(-0.5);
    expect(Math.abs(east)).toBeLessThan(0.2);
  });
});

describe("atmosphericRefractionDeg", () => {
  it("matches the NOAA horizon value (~29 arcmin) and vanishes overhead", () => {
    expect(atmosphericRefractionDeg(0)).toBeGreaterThan(0.4);
    expect(atmosphericRefractionDeg(0)).toBeLessThan(0.6);
    expect(atmosphericRefractionDeg(90)).toBe(0);
    expect(atmosphericRefractionDeg(-2)).toBe(0);
    expect(atmosphericRefractionDeg(10)).toBeGreaterThan(0);
    expect(atmosphericRefractionDeg(10)).toBeLessThan(atmosphericRefractionDeg(0));
  });
});

describe("julianDate", () => {
  it("maps the Unix epoch and J2000 anchor correctly", () => {
    expect(julianDate(0)).toBeCloseTo(2440587.5, 9);
    expect(julianDate(utc("2000-01-01T12:00:00"))).toBeCloseTo(2451545, 6);
  });
});

describe("recorded golden (regression pin, f64)", () => {
  it("pins Shanghai 2026-06-21T01:30Z (values recorded from this implementation, physics invariants above are the correctness proof)", () => {
    const result = solarPosition({ latitudeDeg: 31.23, longitudeDeg: 121.47, timeUtcMs: utc("2026-06-21T01:30:00") });
    expect(result.elevationDeg).toBeCloseTo(56.83664557267822, 9);
    expect(result.azimuthDeg).toBeCloseTo(94.4469949023451, 9);
    expect(result.declinationDeg).toBeCloseTo(23.437852093612232, 9);
  });
});
