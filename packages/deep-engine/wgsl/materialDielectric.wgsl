
fn deepDielectricF0(encodedIor: f32) -> f32 {
  if (encodedIor == 0.0 || encodedIor == 1.5) { return 0.04; }
  let reflectance = 1.0 - 2.0 / (encodedIor + 1.0);
  return reflectance * reflectance;
}
