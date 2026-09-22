//! Narrow 2024 persisted line record. No coordinates are inferred from bounds.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceLine {
    pub element: u32,
    pub source_reference: u64,
    pub offset: usize,
    pub size: usize,
    pub range: [f64; 2],
    pub origin: [f64; 3],
    pub direction: [f64; 3],
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        b.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        b.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}
impl SourceLine {
    pub fn endpoints(&self) -> [[f64; 3]; 2] {
        self.range
            .map(|t| std::array::from_fn(|i| self.origin[i] + t * self.direction[i]))
    }
}
pub fn decode(bytes: &[u8], at: usize, element: u32, source_reference: u64) -> Option<SourceLine> {
    if u64_at(bytes, at)? != u64::from(element) {
        return None;
    }
    let size = u32_at(bytes, at.checked_add(12)?)? as usize;
    if !(100..=1024 * 1024).contains(&size) {
        return None;
    }
    let end = at.checked_add(16)?.checked_add(size)?;
    // Repeated trailing length closes this actual instance record. A nearby
    // line-shaped byte sequence belonging to another record is not accepted.
    if u32_at(bytes, end)? as usize != size || u32_at(bytes, at + 16)? != 0x392 {
        return None;
    }
    let marker = end.checked_sub(68)?;
    if marker < at + 40
        || bytes.get(marker..marker + 4)? != [4, 0, 8, 1]
        || u64_at(bytes, marker - 24)? != source_reference
        || u64_at(bytes, marker - 16)? != u64::MAX
        || u64_at(bytes, marker - 8)? != 0
    {
        return None;
    }
    let mut values = [0.; 8];
    for (i, v) in values.iter_mut().enumerate() {
        *v = f64::from_bits(u64_at(bytes, marker + 4 + i * 8)?);
        if !v.is_finite() {
            return None;
        }
    }
    let range = [values[0], values[1]];
    let origin = [values[2], values[3], values[4]];
    let direction = [values[5], values[6], values[7]];
    let norm = direction.iter().map(|x| x * x).sum::<f64>();
    if range[1] <= range[0] || range[1] - range[0] > 1e7 || (norm - 1.).abs() > 1e-10 {
        return None;
    }
    let line = SourceLine {
        element,
        source_reference,
        offset: at,
        size: size + 20,
        range,
        origin,
        direction,
    };
    if line.endpoints().iter().flatten().any(|v| !v.is_finite()) {
        return None;
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Vec<u8> {
        let mut b = vec![0; 220];
        b[..8].copy_from_slice(&7u64.to_le_bytes());
        b[12..16].copy_from_slice(&200u32.to_le_bytes());
        b[16..20].copy_from_slice(&0x392u32.to_le_bytes());
        b[216..220].copy_from_slice(&200u32.to_le_bytes());
        b[124..132].copy_from_slice(&8u64.to_le_bytes());
        b[132..140].fill(255);
        b[148..152].copy_from_slice(&[4, 0, 8, 1]);
        for (i, v) in [0f64, 5., 1., 2., 3., 0.6, 0.8, 0.].iter().enumerate() {
            b[152 + i * 8..160 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        b
    }
    #[test]
    fn source_direction_is_not_a_bbox_diagonal() {
        let l = decode(&fixture(), 0, 7, 8).unwrap();
        assert_eq!(l.endpoints(), [[1., 2., 3.], [4., 6., 3.]]);
    }
    #[test]
    fn rejects_identity_framing_container_and_invalid_curve() {
        let b = fixture();
        assert!(decode(&b, 0, 8, 8).is_none());
        assert!(decode(&b, 0, 7, 9).is_none());
        for at in [12, 16, 124, 132, 140, 148, 216] {
            let mut x = b.clone();
            x[at] ^= 1;
            assert!(decode(&x, 0, 7, 8).is_none(), "offset {at}");
        }
        for at in [152, 160, 168, 176, 184, 192, 200, 208] {
            let mut x = b.clone();
            x[at..at + 8].copy_from_slice(&f64::NAN.to_le_bytes());
            assert!(decode(&x, 0, 7, 8).is_none());
        }
        for n in 0..b.len() {
            assert!(decode(&b[..n], 0, 7, 8).is_none());
        }
        assert!(decode(&b, usize::MAX, 7, 8).is_none());
    }
}
