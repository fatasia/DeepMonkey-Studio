//! Half-float helpers shared by the original grading probe and its color matrix.
pub(super) fn f16(value: f32) -> u16 {
    if value == 0.0 {
        return 0;
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 112;
    ((exponent.clamp(1, 30) as u16) << 10) | ((bits >> 13) as u16 & 0x03ff)
}

pub(super) fn half(bytes: &[u8], offset: usize) -> f32 {
    let value = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
    let exponent = i32::from((value >> 10) & 0x1f);
    let mantissa = u32::from(value & 0x03ff);
    match exponent {
        0 => (mantissa as f32 / 1_024.0) * 2.0_f32.powi(-14),
        31 => f32::INFINITY,
        _ => (1.0 + mantissa as f32 / 1_024.0) * 2.0_f32.powi(exponent - 15),
    }
}
