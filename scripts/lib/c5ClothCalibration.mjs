import { isDeepStrictEqual } from "node:util";
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const equal = (a, b) => isDeepStrictEqual(a, b);
const shape = poses => poses?.length === 60 && poses.every(frame => frame.length === 4
  && frame.every(point => point.length === 3 && point.every(Number.isFinite)));

/** Compare actual finite-spring solver receipts, without fitting physical parameters. */
export function compareClothCalibration(cloth, bullet) {
  const profiles = cloth.finiteStiffnessConvergence, outputs = bullet.finiteStiffnessConvergence;
  if (profiles?.length !== 3 || outputs?.length !== 3) throw Error("Missing finite stiffness convergence");
  const cases = profiles.map((profile, index) => {
    const c = profile.config, runs = outputs[index], expectedSubsteps = [8, 32, 64][index];
    if (c.columns !== 2 || c.rows !== 2 || c.mass !== .2 || c.spacing !== .1 || c.compliance !== 1 / 40
      || c.damping !== 0 || c.perturbation !== 0 || c.substeps !== expectedSubsteps || c.dtSeconds !== 1 / 60
      || !equal(c.gravity, [0, -9.81, 0]) || !equal(profile.pinned, [2, 3]) || profile.steps !== 60
      || profile.springStiffness !== 40 || profile.allDiagonals !== true) throw Error("Finite spring physical input mismatch");
    if (profile.runs?.length !== 2 || runs?.length !== 2 || !profile.runs.every(run => shape(run.poses))
      || !runs.every(shape) || !equal(profile.runs[0], profile.runs[1]) || !equal(runs[0], runs[1]))
      throw Error("Finite spring output/repetition drift");
    let maxError = 0, maxAnchorDrift = 0;
    for (let t = 0; t < 60; t++) for (let i = 0; i < 4; i++) {
      maxError = Math.max(maxError, distance(profile.runs[0].poses[t][i], runs[0][t][i]));
      if (profile.pinned.includes(i)) maxAnchorDrift = Math.max(maxAnchorDrift,
        distance(profile.runs[0].initial[i], runs[0][t][i]));
    }
    if (maxAnchorDrift > 1e-6) throw Error("Finite spring fixed anchor drift");
    return { substeps: expectedSubsteps, maxError, maxAnchorDrift, withinPreregisteredGate: maxError <= .002 };
  });
  if (!cases[2].withinPreregisteredGate || cases[1].maxError > cases[0].maxError
    || cases[2].maxError > cases[1].maxError) throw Error("Finite spring trajectory did not converge within 0.002m");
  return { scope: "two-by-two-six-edge-finite-spring", cases, repeatStable: true,
    productDefaultsChanged: false, fullClothAccuracyEquivalent: false };
}
