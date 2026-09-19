// E05 光照深水区·切片一（2026-09-19 五轴定档后的必做项）：IES LM-63 光域网解析。
// 纯解析与光度计算层，不依赖渲染后端；运行时把 IesProfile 映射到灯具强度分布的
// 接线由 E02/E05 后续切片完成。格式依据 LM-63-1995/2002：元数据行、TILT、
// 参数头、垂直角、水平角、坎德拉网格。

export interface IesProfile {
  format: string;
  metadata: Record<string, string>;
  tilt: string;
  lampCount: number;
  lumensPerLamp: number;
  multiplier: number;
  verticalAngles: number[];
  horizontalAngles: number[];
  /** photometricType: 1=C（建筑灯具常用）、2=B、3=A */
  photometricType: number;
  unitsType: number;
  luminousOpening: { width: number; length: number; height: number };
  ballastFactor: number;
  inputWatts: number;
  /** candela[i][j]：第 i 个水平角 × 第 j 个垂直角 */
  candela: number[][];
}

export class IesParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `${message}（第 ${line} 行）`);
  }
}

const TILT_NONE = "NONE";

export function parseIesProfile(text: string): IesProfile {
  const lines = text.split(/\r?\n/);
  const metadata: Record<string, string> = {};
  let format = "LM-63-1995";
  let index = 0;
  let sawVersion = false;

  while (index < lines.length) {
    const line = lines[index].trim();
    index += 1;
    if (line.length === 0) continue;
    if (line.startsWith("IESNA:")) {
      format = line.slice("IESNA:".length).trim() || format;
      sawVersion = true;
      continue;
    }
    if (line.startsWith("IES:")) {
      format = line.slice("IES:".length).trim() || format;
      sawVersion = true;
      continue;
    }
    const bracket = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (bracket) {
      metadata[bracket[1].trim().toUpperCase()] = bracket[2].trim();
      continue;
    }
    if (line.toUpperCase().startsWith("TILT")) {
      const tilt = line.split("=")[1]?.trim();
      if (tilt === undefined) throw new IesParseError("TILT 行缺少 '='", index);
      if (tilt.toUpperCase() !== TILT_NONE) {
        throw new IesParseError(`暂不支持 TILT=${tilt}（仅支持 TILT=NONE；含 tilt 数据的文件按合同如实拒绝，不得静默忽略）`, index);
      }
      break;
    }
    throw new IesParseError(`TILT 之前出现无法识别的行：${line.slice(0, 40)}`, index);
  }
  if (!sawVersion && Object.keys(metadata).length === 0) {
    throw new IesParseError("缺少 IESNA/IES 版本行或 [元数据] 行，疑似非 IES 文件", 1);
  }

  const numbers: number[] = [];
  let headerFields: number[] = [];
  let sawHeader = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    if (line.startsWith("[")) continue; // TILT=NONE 之后不应再有元数据，但宽容跳过并继续读数
    for (const token of line.split(/[\s,]+/)) {
      const value = Number(token);
      if (Number.isNaN(value)) throw new IesParseError(`无法解析的数值 token：${token}`, index + 1);
      numbers.push(value);
    }
    if (!sawHeader && numbers.length >= 10) {
      headerFields = numbers.slice(0, 10);
      numbers.splice(0, 10);
      sawHeader = true;
    }
  }
  if (!sawHeader) throw new IesParseError("缺少光度参数头（至少 10 个数值）");

  const [lampCount, lumensPerLamp, multiplier, verticalCount, horizontalCount, photometricType, unitsType, width, length, height] = headerFields;
  if (lampCount < 1) throw new IesParseError(`灯数必须 ≥1，实际 ${lampCount}`);
  if (verticalCount < 1 || horizontalCount < 1) throw new IesParseError(`垂直/水平角数量必须 ≥1，实际 ${verticalCount}/${horizontalCount}`);
  if (!Number.isInteger(verticalCount) || !Number.isInteger(horizontalCount)) throw new IesParseError("角度数量必须为整数");
  if (photometricType < 1 || photometricType > 3) throw new IesParseError(`photometricType 必须为 1/2/3，实际 ${photometricType}`);

  // LM-63 规定参数头后跟镇流器系数/预留/输入功率三元组；部分旧文件省略——
  // 用"剩余数值总数是否恰好等于角度+坎德拉所需"来识别，两种情况都显式处理。
  const requiredAfterTrio = verticalCount + horizontalCount + horizontalCount * verticalCount;
  let ballastFactor = 1;
  let inputWatts = 0;
  if (numbers.length >= requiredAfterTrio + 3) {
    ballastFactor = numbers[0];
    inputWatts = numbers[2];
    numbers.splice(0, 3);
  } else if (numbers.length !== requiredAfterTrio) {
    throw new IesParseError(`数值总数不符：扣除参数头后 ${numbers.length} 个，期望 ${requiredAfterTrio}（无三元组）或 ${requiredAfterTrio + 3}（含三元组）`);
  }

  let cursor = 0;
  const verticalAngles = numbers.slice(cursor, cursor += verticalCount);
  const horizontalAngles = numbers.slice(cursor, cursor += horizontalCount);
  const candelaCount = horizontalCount * verticalCount;
  const flat = numbers.slice(cursor, cursor += candelaCount);
  if (flat.length !== candelaCount) {
    throw new IesParseError(`坎德拉数据不足：期望 ${candelaCount} 个，实际 ${flat.length}`);
  }
  assertAscending("垂直角", verticalAngles);
  assertAscending("水平角", horizontalAngles);
  const candela: number[][] = [];
  for (let h = 0; h < horizontalCount; h += 1) {
    candela.push(flat.slice(h * verticalCount, (h + 1) * verticalCount));
  }

  return {
    format,
    metadata,
    tilt: TILT_NONE,
    lampCount,
    lumensPerLamp,
    multiplier,
    verticalAngles,
    horizontalAngles,
    photometricType,
    unitsType,
    luminousOpening: { width, length, height },
    ballastFactor,
    inputWatts,
    candela,
  };
}

function assertAscending(label: string, angles: number[]): void {
  for (let i = 0; i < angles.length; i += 1) {
    if (angles[i] < 0) throw new IesParseError(`${label}出现负值 ${angles[i]}`);
    if (i > 0 && angles[i] < angles[i - 1]) {
      throw new IesParseError(`${label}必须非降序：${angles[i - 1]} → ${angles[i]}`);
    }
  }
}

export interface IesSummary {
  maxCandela: number;
  totalLuminousFluxLumens: number;
  beamAngleDegrees: number | null;
}

/** 光度汇总：最大坎德拉、总光通量（LM-63 区域积分）、光束角（10% 峰值坎德拉宽度）。 */
export function summarizeIesProfile(profile: IesProfile): IesSummary {
  const peak = Math.max(...profile.candela.flat().map((value) => value * profile.multiplier));
  const beam = beamAngle(profile.verticalAngles, profile.candela[0] ?? [], peak * 0.1, profile.multiplier);
  return {
    maxCandela: Number(peak.toFixed(3)),
    totalLuminousFluxLumens: Number(iesTotalLuminousFlux(profile).toFixed(1)),
    beamAngleDegrees: beam,
  };
}

/**
 * 总光通量：Φ = Σ I(θ,φ)·Δφ·(cosθ₁−cosθ₂)。
 * 水平对称系数：1 个水平角=全周 2π；0–90=×4；0–180=×2；其余按实测区间×对称系数 1。
 */
export function iesTotalLuminousFlux(profile: IesProfile): number {
  const vertical = profile.verticalAngles;
  const horizontal = profile.horizontalAngles;
  const horizontalSpanRadians = ((horizontal[horizontal.length - 1] ?? 0) - horizontal[0]) * Math.PI / 180;
  // 水平对称计数：1 个水平角=全周（宽度 2π、计数 1）；0–90 扫描=×4；0–180=×2；
  // 其余按实测区间计数 1（合同如实：非对称分布不外推）。
  let zoneWidth: number;
  let symmetryCount: number;
  if (horizontal.length === 1) {
    zoneWidth = 2 * Math.PI;
    symmetryCount = 1;
  } else {
    zoneWidth = horizontalSpanRadians / (horizontal.length - 1);
    symmetryCount = Math.abs(horizontalSpanRadians - Math.PI / 2) < 1e-6 ? 4 : Math.abs(horizontalSpanRadians - Math.PI) < 1e-6 ? 2 : 1;
  }

  let flux = 0;
  if (profile.candela.length === 1) {
    // 单水平角：整周旋转对称，该行即全部区域。
    const row = profile.candela[0];
    for (let v = 0; v < row.length - 1; v += 1) {
      const top = vertical[v] * Math.PI / 180;
      const bottom = vertical[v + 1] * Math.PI / 180;
      const meanCandela = (row[v] + row[v + 1]) / 2;
      flux += meanCandela * zoneWidth * (Math.cos(top) - Math.cos(bottom));
    }
    return flux * profile.multiplier * (profile.ballastFactor || 1);
  }
  // 水平区域取相邻两条扫描行的均值坎德拉（区域数 = 行数 − 1），与垂直梯形一致。
  for (let h = 0; h < profile.candela.length - 1; h += 1) {
    const rowA = profile.candela[h];
    const rowB = profile.candela[h + 1];
    for (let v = 0; v < rowA.length - 1; v += 1) {
      const top = vertical[v] * Math.PI / 180;
      const bottom = vertical[v + 1] * Math.PI / 180;
      const meanCandela = (rowA[v] + rowA[v + 1] + rowB[v] + rowB[v + 1]) / 4;
      flux += meanCandela * zoneWidth * (Math.cos(top) - Math.cos(bottom));
    }
  }
  return flux * symmetryCount * profile.multiplier * (profile.ballastFactor || 1);
}

function beamAngle(verticalAngles: number[], row: number[], threshold: number, multiplier: number): number | null {
  if (row.length < 2 || threshold <= 0) return null;
  let first: number | null = null;
  let last: number | null = null;
  for (let v = 0; v < row.length; v += 1) {
    if (row[v] * multiplier < threshold) continue;
    if (first === null) first = verticalAngles[v];
    last = verticalAngles[v];
  }
  if (first === null || last === null) return null;
  return Number((last - first).toFixed(2));
}
