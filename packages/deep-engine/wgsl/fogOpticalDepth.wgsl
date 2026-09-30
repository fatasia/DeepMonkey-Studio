fn deepFogDensityAtHeight(height: f32, baseExtinction: f32, scaleHeight: f32) -> f32 {
  return baseExtinction * exp(-max(height, 0.0) / scaleHeight);
}
fn deepFogTransmittance(opticalDepth: f32) -> f32 {
  return exp(-opticalDepth);
}
