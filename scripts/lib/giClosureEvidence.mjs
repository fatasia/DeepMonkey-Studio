// 收口门槛独立于证据文件，不能由被验收产物自行放宽。
export const GI_CLOSURE_THRESHOLDS = Object.freeze({
  normalizedSsimMin: 0.97,
  normalizedMaeMax: 0.03,
  edgeBandF1Min: 0.9,
});

const unit = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function evaluateGiClosureMatrix(matrix) {
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const complete = matrix?.schemaVersion === 2 && cells.length === 2
    && ["on", "off"].every((kind) => cells.filter((cell) => cell?.kind === kind).length === 1);
  const results = cells.map((cell) => {
    const normalizedSsim = cell?.exposureNormalized?.normalizedSsim;
    const normalizedMae = cell?.exposureNormalized?.normalizedMae;
    const edgeBandF1 = cell?.edgeBand?.f1;
    const passed = unit(normalizedSsim) && unit(normalizedMae) && unit(edgeBandF1)
      && normalizedSsim >= GI_CLOSURE_THRESHOLDS.normalizedSsimMin
      && normalizedMae <= GI_CLOSURE_THRESHOLDS.normalizedMaeMax
      && edgeBandF1 >= GI_CLOSURE_THRESHOLDS.edgeBandF1Min;
    return { kind: cell?.kind, ssim: cell?.metrics?.ssim, normalizedSsim, normalizedMae, edgeBandF1, passed };
  });
  return { complete, passed: complete && results.every((cell) => cell.passed), cells: results };
}
