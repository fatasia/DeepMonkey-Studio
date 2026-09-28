/**
 * T09 切片一:太阳位置天文参考(NOAA 简化算法)。
 *
 * 来源与许可:NOAA Global Monitoring Division "General Solar Position Calculations"
 * (公开文档,美国政府作品,公有领域);公式即天文历书标准式(平黄经/中心差/黄赤交角/
 * 时差),本实现从公式自写,不复制任何受限代码。有效域:1900–2100 年民用精度(≈0.5°)。
 *
 * 约定:
 * - 时间输入为 UTC Unix 毫秒;输出方位角从正北顺时针 [0,360),仰角含大气折射改正
 *   (NOAA 折射式,仰角 ≥ -1° 才适用,以下按几何值返回)。
 * - 全 f64 纯函数,零依赖零随机;同输入逐位同输出(确定性由构造保证)。
 * - 天顶角/仰角是几何量;折射只改观测仰角,不改方向矢量(矢量按几何仰角构造)。
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export interface SolarPositionInput {
  /** 纬度,度,北正 [-90, 90]。 */
  readonly latitudeDeg: number;
  /** 经度,度,东正 [-180, 180]。 */
  readonly longitudeDeg: number;
  /** UTC Unix 时间戳(毫秒)。 */
  readonly timeUtcMs: number;
}

export interface SolarPositionResult {
  /** 几何仰角,度,地平为 0,天顶为 90。 */
  readonly elevationDeg: number;
  /** 含 NOAA 折射改正的视仰角,度。 */
  readonly apparentElevationDeg: number;
  /** 方位角,度,正北 0、正东 90、正南 180、正西 270。 */
  readonly azimuthDeg: number;
  /** 太阳赤纬,度。 */
  readonly declinationDeg: number;
  /** 太阳时角,度,正午为 0,上午为负。 */
  readonly hourAngleDeg: number;
  /** 视黄经,度(中间量,供对拍)。 */
  readonly apparentLongitudeDeg: number;
}

function mod360(degrees: number): number {
  return degrees - 360 * Math.floor(degrees / 360);
}

/** Julian Day(含当日小数)自 Unix 毫秒;2440587.5 = 1970-01-01T00:00Z。 */
export function julianDate(timeUtcMs: number): number {
  return timeUtcMs / 86400000 + 2440587.5;
}

/**
 * 太阳赤纬与平黄经等中间量(NOAA 主链);单独导出供测试与天空模型复用。
 */
export interface SolarEphemeris {
  readonly julianCentury: number;
  readonly geometricMeanLongitudeDeg: number;
  readonly geometricMeanAnomalyDeg: number;
  readonly eccentricity: number;
  readonly equationOfCenterDeg: number;
  readonly apparentLongitudeDeg: number;
  readonly obliquityCorrectionDeg: number;
  readonly declinationDeg: number;
  readonly equationOfTimeMinutes: number;
}

export function solarEphemeris(timeUtcMs: number): SolarEphemeris {
  const jc = (julianDate(timeUtcMs) - 2451545) / 36525;
  const meanLongitude = mod360(280.46646 + jc * (36000.76983 + jc * 0.0003032));
  const meanAnomaly = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const eccentricity = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const mRad = meanAnomaly * DEG2RAD;
  const equationOfCenter =
    Math.sin(mRad) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * mRad) * (0.019993 - 0.000101 * jc)
    + Math.sin(3 * mRad) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCenter;
  const omega = (125.04 - 1934.136 * jc) * DEG2RAD;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega);
  const seconds = 21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813));
  const meanObliquity = 23 + (26 + seconds / 60) / 60;
  const obliquityCorrection = meanObliquity + 0.00256 * Math.cos(omega);
  const declination = Math.asin(Math.sin(obliquityCorrection * DEG2RAD) * Math.sin(apparentLongitude * DEG2RAD)) * RAD2DEG;
  const y = Math.tan(obliquityCorrection * DEG2RAD / 2) ** 2;
  const l0Rad = meanLongitude * DEG2RAD;
  const equationOfTime = 4 * RAD2DEG * (
    y * Math.sin(2 * l0Rad)
    - 2 * eccentricity * Math.sin(mRad)
    + 4 * eccentricity * y * Math.sin(mRad) * Math.cos(2 * l0Rad)
    - y * y * Math.sin(2 * l0Rad) * Math.cos(2 * l0Rad)
  );
  return {
    julianCentury: jc, geometricMeanLongitudeDeg: meanLongitude, geometricMeanAnomalyDeg: meanAnomaly,
    eccentricity, equationOfCenterDeg: equationOfCenter, apparentLongitudeDeg: apparentLongitude,
    obliquityCorrectionDeg: obliquityCorrection, declinationDeg: declination, equationOfTimeMinutes: equationOfTime,
  };
}

/** NOAA 折射改正(分→度):仅对几何仰角 > -1° 适用,返回改正量(度,恒 ≥0)。 */
export function atmosphericRefractionDeg(elevationDeg: number): number {
  if (elevationDeg <= -1) return 0;
  const correctionArcMinutes = 1.02 / Math.tan((elevationDeg + 10.3 / (elevationDeg + 5.11)) * DEG2RAD);
  return Math.max(0, correctionArcMinutes) / 60;
}

/** 太阳方向单位矢量,东-北-上(ENU)右手系:[east, north, up]。 */
export function solarDirectionEnu(input: SolarPositionInput): readonly [number, number, number] {
  const { elevationDeg, azimuthDeg } = solarPosition(input);
  const elevation = elevationDeg * DEG2RAD;
  const azimuth = azimuthDeg * DEG2RAD;
  const cosElevation = Math.cos(elevation);
  return [cosElevation * Math.sin(azimuth), cosElevation * Math.cos(azimuth), Math.sin(elevation)];
}

export function solarPosition(input: SolarPositionInput): SolarPositionResult {
  const { latitudeDeg, longitudeDeg, timeUtcMs } = input;
  if (!Number.isFinite(latitudeDeg) || latitudeDeg < -90 || latitudeDeg > 90) {
    throw new RangeError("latitudeDeg must be finite in [-90, 90].");
  }
  if (!Number.isFinite(longitudeDeg) || longitudeDeg < -180 || longitudeDeg > 180) {
    throw new RangeError("longitudeDeg must be finite in [-180, 180].");
  }
  if (!Number.isFinite(timeUtcMs)) throw new RangeError("timeUtcMs must be finite.");
  const ephemeris = solarEphemeris(timeUtcMs);
  // 真太阳时(分,mod 1440):均时差 + 4 分/度经度 + 当日 UTC 分钟(取自时间戳的日内小数)。
  const dayFraction = (julianDate(timeUtcMs) + 0.5) % 1;
  const minutesUtc = dayFraction * 1440;
  const trueSolarTime = ((ephemeris.equationOfTimeMinutes + 4 * longitudeDeg + minutesUtc) % 1440 + 1440) % 1440;
  const hourAngleDeg = trueSolarTime / 4 - 180;
  const latRad = latitudeDeg * DEG2RAD;
  const decRad = ephemeris.declinationDeg * DEG2RAD;
  const haRad = hourAngleDeg * DEG2RAD;
  const sinElevation = Math.sin(latRad) * Math.sin(decRad)
    + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, sinElevation))) * RAD2DEG;
  // 方位角自正北顺时针:atan2(-cosδ·sinH, sinδ·cosφ − cosδ·sinφ·cosH)。
  const azimuthDeg = mod360(Math.atan2(
    -Math.cos(decRad) * Math.sin(haRad),
    Math.sin(decRad) * Math.cos(latRad) - Math.cos(decRad) * Math.sin(latRad) * Math.cos(haRad),
  ) * RAD2DEG);
  const refraction = atmosphericRefractionDeg(elevationDeg);
  return {
    elevationDeg, apparentElevationDeg: elevationDeg + refraction, azimuthDeg,
    declinationDeg: ephemeris.declinationDeg, hourAngleDeg, apparentLongitudeDeg: ephemeris.apparentLongitudeDeg,
  };
}
