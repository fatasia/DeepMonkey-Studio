// Explicit microfacet-metal-reflection: normalized anisotropic GGX, matched Smith G2,
// Schlick conductor reflection. Returns BRDF*cos(theta_l)*radiance; no diffuse,
// multiple scattering, refraction or resource bindings. Legacy stock stays separate.
fn deepMetalProjectedRoot(w: vec3f, nDotW: f32,
  tangent: vec3f, bitangent: vec3f, ax: f32, ay: f32) -> f32 {
  let tangentSlope = ax * dot(tangent, w);
  let bitangentSlope = ay * dot(bitangent, w);
  return sqrt(nDotW * nDotW + tangentSlope * tangentSlope + bitangentSlope * bitangentSlope);
}

fn deepMetalReflectionDirect(baseColor: vec3f, roughness: f32,
  normalIn: vec3f, viewIn: vec3f, lightIn: vec3f, tangentIn: vec3f, radiance: vec3f,
  strength: f32, rotation: f32) -> vec3f {
  let normal = deepMaterialSafeNormalize(normalIn, vec3f(0.0, 0.0, 1.0));
  let view = deepMaterialSafeNormalize(viewIn, vec3f(0.0, 0.0, 1.0));
  let light = deepMaterialSafeNormalize(lightIn, vec3f(0.0, 0.0, 1.0));
  let rawNdotV = dot(normal, view);
  let nDotL = clamp(dot(normal, light), 0.0, 1.0);
  if (rawNdotV <= 0.0 || nDotL <= 0.0) {
    return vec3f(0.0);
  }
  let nDotV = clamp(rawNdotV, 0.0, 1.0);
  let halfVector = deepMaterialSafeNormalize(view + light, normal);
  let nDotH = clamp(dot(normal, halfVector), 0.0, 1.0);
  let vDotH = clamp(dot(view, halfVector), 0.0, 1.0);
  let fallbackAxis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(normal.x) > 0.9);
  let fallback = deepMaterialSafeNormalize(deepMaterialCross(fallbackAxis, normal), vec3f(0.0, 0.0, 1.0));
  let tangent = deepMaterialSafeNormalize(tangentIn - normal * dot(normal, tangentIn), fallback);
  let bitangent = deepMaterialSafeNormalize(deepMaterialCross(normal, tangent), vec3f(0.0, 1.0, 0.0));
  let rotatedTangent = tangent * cos(rotation) + bitangent * sin(rotation);
  let rotatedBitangent = bitangent * cos(rotation) - tangent * sin(rotation);
  let rough = clamp(roughness, 0.045, 1.0);
  let alpha = rough * rough;
  let ax = max(alpha * (1.0 + strength), 0.001);
  let ay = max(alpha, 0.001);
  let th = dot(rotatedTangent, halfVector) / ax;
  let bh = dot(rotatedBitangent, halfVector) / ay;
  let denominator = th * th + bh * bh + nDotH * nDotH;
  let distribution = 1.0 / (DEEP_MATERIAL_PI * ax * ay * denominator * denominator);
  // Algebraically G2/(4*nv*nl), without asymmetric angular floors or large slopes.
  let visibility = 0.5 / (
    nDotL * deepMetalProjectedRoot(view, nDotV, rotatedTangent, rotatedBitangent, ax, ay)
    + nDotV * deepMetalProjectedRoot(light, nDotL, rotatedTangent, rotatedBitangent, ax, ay));
  let fresnel = baseColor + (vec3f(1.0) - baseColor) * pow(1.0 - vDotH, 5.0);
  return fresnel * distribution * visibility * nDotL * radiance;
}
