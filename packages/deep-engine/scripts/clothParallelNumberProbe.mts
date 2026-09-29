// 临时跑数探针(用后即删):f32 色序镜像 vs f64 黄金,noWind 配置 240 ticks。
import { readFileSync } from "node:fs";
import { ClothSolver } from "../src/physics/clothSolver.js";
import { ClothParallelMirror, buildClothParallelState } from "../src/physics/clothParallelSolver.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../deep-engine-native/tests/fixtures/cloth-softbody-solver-parity-v1.json", import.meta.url), "utf8"));
const config = fixture.cloth.config;
const pinned = fixture.cloth.pinned;
const ticks = fixture.cloth.noWind.ticks;
console.log("ticks=", ticks, "fingerprintGolden=", fixture.cloth.noWind.fingerprint);

const golden = new ClothSolver({ ...config });
for (const [col, row] of pinned) golden.setPinned(col, row, true);
const goldenPositionsAt = new Map();
goldenPositionsAt.set(0, golden.capture());
for (let t = 1; t <= ticks; t += 1) {
  golden.step();
  if (t % 24 === 0 || t === ticks) goldenPositionsAt.set(t, golden.capture());
}

const build = buildClothParallelState({
  columns: config.columns, rows: config.rows, spacing: config.spacing, mass: config.mass,
  gravity: config.gravity, dtSeconds: config.dtSeconds, substeps: config.substeps,
  compliance: config.compliance, damping: config.damping, perturbation: config.perturbation,
  seed: config.seed, origin: config.origin,
  pinned,
});
console.log("particles=", build.particleCount, "constraints=", build.constraintCount,
  "colors=", build.coloring.colorCount, "maxDegree=", build.coloring.maxDegree);
console.log("colorRanges=", build.coloring.colorRanges.map(([s, e]) => `${s}-${e}`).join(","));

const mirror = new ClothParallelMirror(build);
console.log("tick | fp32(sim) | maxPosErr(m) | meanPosErr | kinetic(last)");
for (let t = 1; t <= ticks; t += 1) {
  mirror.step();
  if (t % 24 === 0 || t === ticks) {
    const snap = goldenPositionsAt.get(t);
    const state = mirror.captureState();
    let maxErr = 0; let sumErr = 0;
    for (let i = 0; i < build.particleCount; i += 1) {
      const dx = state[i * 12] - snap.px[i];
      const dy = state[i * 12 + 1] - snap.py[i];
      const dz = state[i * 12 + 2] - snap.pz[i];
      const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (err > maxErr) maxErr = err;
      sumErr += err;
    }
    const kinetic = mirror.kineticPerSubstep[mirror.kineticPerSubstep.length - 1];
    console.log(`${t} | ${mirror.stateFingerprint32()} | ${maxErr.toExponential(3)} | ${(sumErr / build.particleCount).toExponential(3)} | ${kinetic.toExponential(4)}`);
  }
}
const stretch = mirror.measureStretch();
console.log("mirror stretch maxRatio=", stretch.maxRatio, "meanRatio=", stretch.meanRatio);
const goldenStretch = golden.measureStretch();
console.log("golden stretch maxRatio=", goldenStretch.maxRatio, "meanRatio=", goldenStretch.meanRatio);

// 双跑逐位
const mirror2 = new ClothParallelMirror(buildClothParallelState({
  columns: config.columns, rows: config.rows, spacing: config.spacing, mass: config.mass,
  gravity: config.gravity, dtSeconds: config.dtSeconds, substeps: config.substeps,
  compliance: config.compliance, damping: config.damping, perturbation: config.perturbation,
  seed: config.seed, origin: config.origin, pinned,
}));
for (let t = 0; t < ticks; t += 1) mirror2.step();
console.log("replay bitwise identical:", mirror.stateFingerprint32() === mirror2.stateFingerprint32());
