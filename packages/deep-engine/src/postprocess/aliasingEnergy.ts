/**
 * 阶梯(走样)能量度量——AA-M2 组合档验收门的 CPU 尺子。
 * 语义(对标 SMAA/Jimenez 系的 staircase energy 惯例,落地为可复现的解析定义):
 * 以 4× 超采样解析参考为真值,在**边缘区**(参考图梯度超阈值的像素,即几何
 * 轮廓所在)度量平均绝对 Luma 残差并按源对比度归一化。AA 前后同口径对比,
 * 降幅 ≥80% 即达标(antialiasing-master-plan-20261003 §L3/AA-M2)。
 * 与 ghostEnergy(temporalReprojection)同骨架:残差/源对比度,保证跨度量
 * 数字可互比;差异在本度量带边缘区掩码(阶梯能量只在轮廓处计,全图平均会被
 * 大面积平坦区稀释)。
 */

export interface AliasingEnergyInput {
  /** 被评渲染输出(RGBA8 或线性 RGBA,逐像素 4 分量)。 */
  readonly output: ArrayLike<number>;
  /** 4× 超采样解析参考(同尺寸下采样到输出分辨率)。 */
  readonly reference: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  /** 源对比度(场景明暗差,归一化分母;≤0 或非有限即抛)。 */
  readonly sourceContrast: number;
  /** 边缘区梯度阈值(参考图 Sobel Luma;缺省 0.06,与 T07 触发线同量级)。 */
  readonly edgeGradientThreshold?: number;
}

export interface AliasingEnergyReport {
  /** 边缘区平均绝对 Luma 残差(源对比度归一化)——走样能量的主指标。 */
  readonly edgeEnergy: number;
  /** 全图平均绝对 Luma 残差(同归一化;参照指标,不作门)。 */
  readonly totalEnergy: number;
  /** 边缘区像素数(掩码透明度)。 */
  readonly edgePixels: number;
}

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/** 参考 Sobel Luma 梯度幅值(非负;输入越界钳制,不产 NaN)。 */
function referenceGradient(reference: ArrayLike<number>, width: number, height: number, x: number, y: number): number {
  const at = (px: number, py: number): number => {
    const cx = Math.min(width - 1, Math.max(0, px)), cy = Math.min(height - 1, Math.max(0, py));
    const offset = (cy * width + cx) * 4;
    return luma(reference[offset]!, reference[offset + 1]!, reference[offset + 2]!);
  };
  const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
  const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
  return Math.hypot(gx, gy);
}

/**
 * 阶梯能量:边缘区内 |output−reference| 的 Luma 平均(对比度归一化)。
 * 尺寸不一致/对比度非法即抛(fail-closed);边缘阈值为 0 时退化为全图度量。
 */
export function measureAliasingEnergy(input: AliasingEnergyInput): AliasingEnergyReport {
  const { output, reference, width, height, sourceContrast } = input;
  if (sourceContrast <= 0 || !Number.isFinite(sourceContrast)) throw new Error("Aliasing energy source contrast is invalid.");
  if (output.length !== reference.length || output.length < width * height * 4) {
    throw new Error("Aliasing energy buffers differ in size.");
  }
  const threshold = input.edgeGradientThreshold ?? 0.06;
  let edgeResidual = 0, edgePixels = 0, totalResidual = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    const referenceLuma = luma(reference[pixel]!, reference[pixel + 1]!, reference[pixel + 2]!);
    const outputLuma = luma(output[pixel]!, output[pixel + 1]!, output[pixel + 2]!);
    const residual = Math.abs(outputLuma - referenceLuma);
    totalResidual += residual;
    if (referenceGradient(reference, width, height, x, y) > threshold) { edgeResidual += residual; edgePixels++; }
  }
  const normalize = (sum: number, samples: number): number => samples === 0 ? 0 : sum / (samples * sourceContrast);
  return { edgeEnergy: normalize(edgeResidual, edgePixels), totalEnergy: normalize(totalResidual, width * height), edgePixels };
}

/** 阶梯降幅(%):AA 前/后同口径边缘能量,下降比例;基线能量 ≤0 即抛(无意义)。 */
export function aliasingReduction(before: number, after: number): number {
  if (!(before > 0) || !Number.isFinite(before)) throw new Error("Aliasing reduction requires a positive baseline energy.");
  return Math.max(0, (before - after) / before);
}

/** 阶梯场景包:no-AA 输出、4×SSAA 参考、源对比度与几何覆盖判定器(单一来源)。 */
export interface StaircaseScenario {
  readonly noAA: Float32Array;
  readonly reference: Float32Array;
  readonly sourceContrast: number;
  /** 连续像素坐标 (px,py) 的二值几何覆盖判定(场景几何真值单一来源)。 */
  readonly coverAt: (px: number, py: number) => boolean;
}

/**
 * 欠采样极限口径的解析 45° 阶梯图案(含细栅栏与圆弧三类走样源)的 RGBA 输出与
 * 4×SSAA 参考:**口径警示(2026-10-04 AA-M2 门①根因实证)**——本场景的 3px 周期
 * 细栅栏与 1px 圆弧是欠采样纹理,像素网格采样后信息已不可恢复,采样定理下任何
 * 空间 AA 都无法重建 4×SSAA 参考(SMAA GPU 11.6%/FXAA 7.9%;iryoku AreaTex.py
 * 对拍证实 SMAA 查表值为官方几何语义)。它保留为**度量 AA 的下界诚实性口径**
 * (衡量 AA 在不可恢复走样上不产生幻觉残差),门①判定用 `resolvableStaircaseCase`。
 * 覆盖函数按几何解析覆盖率混合双色——no-AA 输出用像素中心覆盖(0/1),参考用
 * 4× 子采样覆盖率(0,.25,.5,.75,1)。这是度量自持的测试与探针场景源。
 */
export function syntheticStaircaseCase(width: number, height: number): StaircaseScenario {
  const covered = (px: number, py: number): boolean => {
    // 三类阶梯源:45° 主阶梯(对角下半)、周期 3px 细栅栏(限底部带,保平坦区占比)、
    // 环距 20px 同心圆弧——密度以"边缘掩码有区分度"为准,不以图案炫技为准。
    const staircase = py > 0.35 * height + px * 0.5;
    const fence = ((px * 2) % 3) < 1.2 && py > 0.72 * height;
    const arc = Math.hypot(px - width * 0.7, py - height * 0.35) % 20 < 1.0;
    return staircase || fence || arc;
  };
  return buildStaircaseScenario(width, height, covered);
}

/**
 * 可采样口径的解析阶梯图案(AA-M2 门①判定场景,2026-10-04 口径修正):
 * 全部几何特征满足采样定理——大面积区域间的锐利斜边(45° 主斜边,相位随分辨率
 * 连变、非像素对齐)、≥2px 投影宽度的粗栅栏(周期 8px/杆宽 3px)、粗同心圆弧
 * (环距 24px/线宽 3px/最小半径 12px≥4px,曲率半径远大于线宽),无任何 ≤2px
 * 周期结构。这类"可恢复走样"正是 MSAA/SMAA/TSR 的设计目标:覆盖率渐变可由
 * 有限采样重建,门①(↓≥80%)在此口径上有原理可行性。4×SSAA 参考照旧。
 */
export function resolvableStaircaseCase(width: number, height: number): StaircaseScenario {
  const covered = (px: number, py: number): boolean => {
    // 三类阶梯源(与欠采样场景同构,特征全部放大到可采样尺度):
    // 45° 主斜边(大面积区域分割,相位偏移 -0.3×width 避免像素对齐阶梯);
    // 粗栅栏:周期 8px、杆宽 3px(≥2px 投影宽度),限底部带保平坦区占比;
    // 粗同心圆弧:环距 24px、线宽 3px,最小半径 12px(≥4px)。
    const staircase = py > 0.42 * height + px - 0.3 * width;
    const fence = (px % 8) < 3 && py > 0.72 * height;
    const radius = Math.hypot(px - width * 0.7, py - height * 0.35);
    const arc = radius >= 12 && (radius % 24) < 3;
    return staircase || fence || arc;
  };
  return buildStaircaseScenario(width, height, covered);
}

/** 场景构建公共骨架:几何判定器 → no-AA 像素中心采样 + 4×SSAA 16 子采样参考。 */
function buildStaircaseScenario(width: number, height: number,
  covered: (px: number, py: number) => boolean): StaircaseScenario {
  const noAA = new Float32Array(width * height * 4), reference = new Float32Array(width * height * 4);
  const dark = 0.1, bright = 0.9;
  const sourceContrast = bright - dark;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4;
    const value = (level: number): [number, number, number, number] =>
      level > 0 ? [bright, bright, bright, 1] : [dark, dark, dark, 1];
    // 历史口径锁:no-AA 中心采样在 (x+0.375, y+0.375)(= 旧实现 covered(x,y,1,1)
    // 的子采样格点),与 smaaGpuAcceptanceProbe 既有证据(基线 0.1382)同尺;
    // 不得"顺手修正"为 x+0.5,否则历史能量数字全部静默漂移。
    const center = covered(x + 0.375, y + 0.375) ? 1 : 0;
    noAA.set(value(center), pixel);
    let sum = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      sum += covered(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) ? 1 : 0;
    }
    const coverage = sum / 16;
    reference.set([dark + (bright - dark) * coverage, dark + (bright - dark) * coverage,
      dark + (bright - dark) * coverage, 1], pixel);
  }
  return { noAA, reference, sourceContrast, coverAt: covered };
}
