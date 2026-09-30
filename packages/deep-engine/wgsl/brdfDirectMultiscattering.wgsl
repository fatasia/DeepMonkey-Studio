// Direct GGX energy compensation; DFG sampling stays in each host.
fn deepDirectMultiscatteringEnergy(f0: vec3f, dfgView: vec2f, dfgLight: vec2f) -> vec3f {
  let singleView = f0 * dfgView.x + dfgView.y;
  let singleLight = f0 * dfgLight.x + dfgLight.y;
  let lostView = 1.0 - (dfgView.x + dfgView.y);
  let lostLight = 1.0 - (dfgLight.x + dfgLight.y);
  let averageFresnel = f0 + (1.0 - f0) * 0.047619;
  let multiple = singleView * singleLight * averageFresnel
    / (1.0 - lostView * lostLight * averageFresnel + 0.000001);
  return multiple * (lostView * lostLight);
}
