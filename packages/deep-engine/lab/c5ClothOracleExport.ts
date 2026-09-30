import { ClothSolver } from "../src/physics/clothSolver.js";

/** Export the actual existing XPBD implementation; no second cloth evaluator. */
export function exportClothOracleInput() {
  const config = { columns: 12, rows: 12, spacing: .1, mass: .2,
    gravity: [0, -9.81, 0] as const, dtSeconds: 1 / 60, substeps: 8,
    compliance: 0, damping: .01, perturbation: .005, seed: 20260927, wind: null };
  const runs = [];
  for (let round = 0; round < 2; round++) {
    const solver = new ClothSolver(config);
    solver.setPinned(0, 11, true); solver.setPinned(11, 11, true);
    const points = () => { const s = solver.capture(); return Array.from(s.px, (x, i) => [x, s.py[i]!, s.pz[i]!]); };
    const initial = points(), poses = [];
    for (let tick = 0; tick < 240; tick++) { solver.step(); poses.push(points()); }
    runs.push({ initial, poses, stretch: solver.measureStretch() });
  }
  const freeSolver = new ClothSolver({ ...config, damping: 0, perturbation: 0 });
  const freePoints = () => { const s = freeSolver.capture(); return Array.from(s.px, (x, i) => [x, s.py[i]!, s.pz[i]!]); };
  const freeInitial = freePoints(), freePoses = [];
  for (let tick = 0; tick < 30; tick++) { freeSolver.step(); freePoses.push(freePoints()); }
  const finiteStiffnessConvergence = [8, 32, 64].map(substeps => {
    const finiteConfig = { ...config, columns: 2, rows: 2, substeps, compliance: 1 / 40, damping: 0, perturbation: 0 };
    const finiteRuns = [];
    for (let round = 0; round < 2; round++) {
      const solver = new ClothSolver(finiteConfig);
      solver.setPinned(0, 1, true); solver.setPinned(1, 1, true);
      const points = () => { const s = solver.capture(); return Array.from(s.px, (x, i) => [x, s.py[i]!, s.pz[i]!]); };
      const initial = points(), poses = [];
      for (let tick = 0; tick < 60; tick++) { solver.step(); poses.push(points()); }
      finiteRuns.push({ initial, poses });
    }
    return { config: finiteConfig, pinned: [2, 3], steps: 60, springStiffness: 40, allDiagonals: true, runs: finiteRuns };
  });
  return { config, pinned: [132, 143], steps: 240, runs, freeFall: {
    config: { ...config, damping: 0, perturbation: 0 }, pinned: [], steps: 30,
    runs: [{ initial: freeInitial, poses: freePoses }, { initial: freeInitial, poses: freePoses }],
  }, finiteStiffnessConvergence };
}
