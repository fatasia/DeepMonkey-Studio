pub fn srgb_channel_to_linear(value: u8) -> f32 {
    let value = value as f32 / 255.0;
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

pub fn occlusion_factor(red: u8, strength: f32) -> f32 {
    1.0 + strength * (red as f32 / 255.0 - 1.0)
}

pub fn decode_tangent_normal(rgb: [u8; 3], scale: f32) -> [f32; 3] {
    let mut value = [
        (rgb[0] as f32 / 255.0 * 2.0 - 1.0) * scale,
        (rgb[1] as f32 / 255.0 * 2.0 - 1.0) * scale,
        rgb[2] as f32 / 255.0 * 2.0 - 1.0,
    ];
    let length = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
    for component in &mut value {
        *component /= length;
    }
    value
}

pub fn mask_covered(base_color_alpha: f32, sampled_alpha: u8, cutoff: f32) -> bool {
    base_color_alpha * sampled_alpha as f32 / 255.0 >= cutoff
}

pub fn straight_alpha_over(source: [f32; 4], destination: [f32; 4]) -> [f32; 4] {
    let inverse = 1.0 - source[3];
    [
        source[0] * source[3] + destination[0] * inverse,
        source[1] * source[3] + destination[1] * inverse,
        source[2] * source[3] + destination[2] * inverse,
        source[3] + destination[3] * inverse,
    ]
}
