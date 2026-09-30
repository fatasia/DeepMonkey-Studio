// Binding-free CSM blending; last-cascade selection stays with each host.
fn deepCascadeBlendInactive(viewDepth: f32, blendStart: f32, split: f32) -> bool {
  return blendStart >= split || viewDepth <= blendStart;
}

// Call only after the inactive guard, so the smoothstep interval has positive width.
fn deepCascadeBlendWeight(viewDepth: f32, blendStart: f32, split: f32) -> f32 {
  return smoothstep(blendStart, split, viewDepth);
}
