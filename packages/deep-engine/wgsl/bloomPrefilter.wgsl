// max-RGB soft-knee arithmetic; sampling and knee/epsilon policy belong to each host.
fn deepBloomSoftKnee(brightness: f32, threshold: f32, knee: f32, denominatorBias: f32) -> f32 {
  let transition = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  return transition * transition / (4.0 * knee + denominatorBias);
}

fn deepBloomContribution(brightness: f32, threshold: f32, soft: f32) -> f32 {
  return max(brightness - threshold, soft) / max(brightness, 0.00001);
}
