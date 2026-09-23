// 逐像素对拍纯算法库（V1 三端 runner 切片 4/5 共用）：分块 SSIM、线性校准（归一化尝试）、
// 分块差异热图。无 IO、无第三方依赖——输入为等长灰度 Float64Array（0..255 标量），
// 便于 runner 之外单独复算与单元复核。
//
// 口径（第一版基线，如实出数、不设达标线、不判胜负）：
// - 灰度：runner 侧统一把各端帧线性重采样到 960×540、经 sharp `.grayscale()`
//   （libvips b-w，sRGB 亮度系数 0.2126/0.7152/0.0722）得 8bit 单通道后转 float64。
//   WebView2 物理像素帧（1500×844）下采样到 960×540 会吸收部分抗锯齿/锐度差异，属本口径一部分。
// - 分块 SSIM：960×540 划为 16×9=144 块（每块 60×60，不重叠；块内总体统计等价均匀窗 SSIM），
//   L=255，C1=(0.01·L)²、C2=(0.03·L)²；全局值=全部块 SSIM 的算术平均，理论范围 [-1,1]，1 为逐块相同。
// - 线性校准（曝光/色调映射类系统性差异的归一化尝试）：以参照帧为 y、比较帧为 x 做全图
//   最小二乘 y ≈ a·x + b，将 x 校正并 clamp 回 [0,255] 后重算 SSIM；a、b 随证据落盘，
//   报告同时给出归一化前后两套数值，不宣称哪一套"更正确"。

const L = 255;
const C1 = (0.01 * L) ** 2;
const C2 = (0.03 * L) ** 2;

/**
 * 分块 SSIM。
 * @param {Float64Array} a 比较帧灰度（0..255）
 * @param {Float64Array} b 参照帧灰度（0..255），与 a 等长
 * @param {number} width 图宽（像素）
 * @param {number} height 图高（像素）
 * @param {number} blockCols 横向块数（默认 16，对应 960 宽 → 块宽 60）
 * @param {number} blockRows 纵向块数（默认 9，对应 540 高 → 块高 60）
 * @returns {{ mean: number, min: number, max: number, blocks: number[] }}
 *   blocks 行优先（先上后下、先左后右），与图像行扫描顺序一致。
 */
export function computeBlockSsim(a, b, width, height, blockCols = 16, blockRows = 9) {
  if (a.length !== b.length) throw new Error(`分块 SSIM 输入长度不一致：${a.length} vs ${b.length}`);
  if (a.length !== width * height) throw new Error(`分块 SSIM 输入长度 ${a.length} 与 ${width}×${height} 不符`);
  const blockWidth = width / blockCols, blockHeight = height / blockRows;
  if (!Number.isInteger(blockWidth) || !Number.isInteger(blockHeight)) {
    throw new Error(`图像 ${width}×${height} 不能被 ${blockCols}×${blockRows} 块整除`);
  }
  const blocks = [];
  for (let row = 0; row < blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      // 块内总体统计量（μ、σ²、σxy，分母取 n）：等价于均匀窗、步长=块大小的 SSIM 局部估计。
      let sumA = 0, sumB = 0;
      const y0 = row * blockHeight, x0 = col * blockWidth;
      for (let y = y0; y < y0 + blockHeight; y += 1) {
        const base = y * width;
        for (let x = x0; x < x0 + blockWidth; x += 1) { sumA += a[base + x]; sumB += b[base + x]; }
      }
      const n = blockWidth * blockHeight;
      const meanA = sumA / n, meanB = sumB / n;
      let varA = 0, varB = 0, covAB = 0;
      for (let y = y0; y < y0 + blockHeight; y += 1) {
        const base = y * width;
        for (let x = x0; x < x0 + blockWidth; x += 1) {
          const da = a[base + x] - meanA, db = b[base + x] - meanB;
          varA += da * da; varB += db * db; covAB += da * db;
        }
      }
      varA /= n; varB /= n; covAB /= n;
      const ssim = ((2 * meanA * meanB + C1) * (2 * covAB + C2)) /
        ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      blocks.push(ssim);
    }
  }
  const mean = blocks.reduce((sum, value) => sum + value, 0) / blocks.length;
  return { mean, min: Math.min(...blocks), max: Math.max(...blocks), blocks };
}

/**
 * 全图最小二乘线性校准参数：拟合 y ≈ a·x + b（x=比较帧、y=参照帧，逐像素成对）。
 * a = cov(x,y)/var(x)；var(x) 退化（近纯色帧）时返回 a=1、b=mean(y)-mean(x) 的平移兜底并在 devXxx 记为零方差。
 */
export function fitLinearCalibration(x, y) {
  if (x.length !== y.length) throw new Error(`线性校准输入长度不一致：${x.length} vs ${y.length}`);
  const n = x.length;
  let meanX = 0, meanY = 0;
  for (let i = 0; i < n; i += 1) { meanX += x[i]; meanY += y[i]; }
  meanX /= n; meanY /= n;
  let covXY = 0, varX = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - meanX, dy = y[i] - meanY;
    covXY += dx * dy; varX += dx * dx;
  }
  covXY /= n; varX /= n;
  const degenerate = varX < 1e-9;
  const a = degenerate ? 1 : covXY / varX;
  const b = degenerate ? meanY - meanX : meanY - a * meanX;
  return { a, b, degenerate };
}

/** 应用线性校准并 clamp 回 [0,255]（帧值域仍是 8bit 灰度口径）。返回新数组，不改写输入。 */
export function applyLinearCalibration(x, a, b) {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i += 1) {
    const value = a * x[i] + b;
    out[i] = value < 0 ? 0 : value > L ? L : value;
  }
  return out;
}

/**
 * 分块差异热图：把每块的差异值（调用方给 1-SSIM 之类的 [0,1] 标量，超出则截断）上色后
 * 按块放大为 width×height 的 RGB raw（行优先、无 alpha），供 sharp `.raw()` 直接编码 PNG。
 * 配色梯度（低→高差异）：深蓝黑 → 蓝 → 青 → 橙 → 亮黄，保证在深色背景下"越红越异常"不反直觉。
 */
export function buildBlockHeatmapRgb(blockValues, blockCols, blockRows, width, height) {
  const blockWidth = width / blockCols, blockHeight = height / blockRows;
  if (!Number.isInteger(blockWidth) || !Number.isInteger(blockHeight)) {
    throw new Error(`热图尺寸 ${width}×${height} 不能被 ${blockCols}×${blockRows} 块整除`);
  }
  const rgb = new Uint8Array(width * height * 3);
  // 分段线性色标：[t, r, g, b] 按 t 升序，两端截断。
  const stops = [
    [0.00, 8, 8, 30], [0.20, 30, 60, 160], [0.45, 40, 170, 200],
    [0.70, 240, 140, 30], [0.90, 255, 230, 60], [1.00, 255, 40, 40],
  ];
  const colorAt = value => {
    const t = Math.max(0, Math.min(1, value));
    for (let i = 1; i < stops.length; i += 1) {
      if (t <= stops[i][0]) {
        const [t0, r0, g0, b0] = stops[i - 1], [t1, r1, g1, b1] = stops[i];
        const k = (t - t0) / (t1 - t0);
        return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
      }
    }
    return [255, 40, 40];
  };
  for (let row = 0; row < blockRows; row += 1) {
    for (let col = 0; col < blockCols; col += 1) {
      const [r, g, b] = colorAt(blockValues[row * blockCols + col]);
      for (let y = row * blockHeight; y < (row + 1) * blockHeight; y += 1) {
        const base = (y * width + col * blockWidth) * 3;
        for (let x = 0; x < blockWidth; x += 1) {
          const at = base + x * 3;
          rgb[at] = r; rgb[at + 1] = g; rgb[at + 2] = b;
        }
      }
    }
  }
  return rgb;
}
