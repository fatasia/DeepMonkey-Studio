pub(crate) fn f32_to_f16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;
    if exponent <= 0 {
        if exponent < -10 {
            return sign;
        }
        let mantissa = mantissa | 0x80_0000;
        let shift = (14 - exponent) as u32;
        return sign | ((mantissa + (1 << (shift - 1))) >> shift) as u16;
    }
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    let mut half = sign | ((exponent as u16) << 10) | (mantissa >> 13) as u16;
    let remainder = mantissa & 0x1fff;
    if remainder > 0x1000 || (remainder == 0x1000 && half & 1 != 0) {
        half = half.saturating_add(1);
    }
    half
}

#[cfg(test)]
mod tests {
    use super::f32_to_f16;

    #[test]
    fn encodes_finite_hdr_channels_as_half_float() {
        assert_eq!(f32_to_f16(0.0), 0x0000);
        assert_eq!(f32_to_f16(1.0), 0x3c00);
        assert_eq!(f32_to_f16(2.0), 0x4000);
        assert_eq!(f32_to_f16(0.5), 0x3800);
    }
}
