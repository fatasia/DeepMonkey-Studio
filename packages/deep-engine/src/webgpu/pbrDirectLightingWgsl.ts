/** Direct-light GGX with correlated Smith visibility and no extra texture fetches. */
export const PBR_DIRECT_LIGHTING_WGSL = /* wgsl */ `
fn fresnel(cosine: f32, f0: vec3f) -> vec3f {
  let factor = exp2((-5.55473 * cosine - 6.98316) * cosine);
  return f0 * (1.0 - factor) + factor;
}
fn deepGeometryRoughness(normal: vec3f) -> f32 {
  let derivative = max(abs(dpdx(normal)), abs(dpdy(normal)));
  return max(max(derivative.x, derivative.y), derivative.z);
}
fn brdf(n: vec3f, v: vec3f, l: vec3f, base: vec3f, metal: f32, rough: f32) -> vec3f {
  let h = safeNormalize(v + l, n); let nv = clamp(dot(n, v), 0.0001, 1.0); let nl = clamp(dot(n, l), 0.0, 1.0);
  let nh = clamp(dot(n, h), 0.0, 1.0); let vh = clamp(dot(v, h), 0.0, 1.0);
  let alpha = rough * rough; let a2 = alpha * alpha; let denom = nh * nh * (a2 - 1.0) + 1.0;
  let distribution = a2 / max(3.14159265 * denom * denom, 0.000001);
  let gv = nl * sqrt(a2 + (1.0 - a2) * nv * nv);
  let gl = nv * sqrt(a2 + (1.0 - a2) * nl * nl);
  let visibility = 0.5 / max(gv + gl, 0.000001);
  let f0 = mix(vec3f(0.04), base, metal); let f = fresnel(vh, f0);
  let specular = f * visibility * distribution;
  let diffuse = (1.0 - metal) * base / 3.14159265;
  return (diffuse + specular) * nl;
}
`;
