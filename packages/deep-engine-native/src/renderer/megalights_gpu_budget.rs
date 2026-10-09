//! Full material/depth resolution with bounded RIS sampling scratch.
pub(crate) const BUDGET_BYTES: u64 = 256 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Resolution {
    pub full: (u32, u32),
    pub ris: (u32, u32),
    pub bytes: u64,
}
pub(crate) fn resolution(width: u32, height: u32) -> Option<Resolution> {
    plan(width, height, BUDGET_BYTES)
}
fn plan(width: u32, height: u32, budget: u64) -> Option<Resolution> {
    if width == 0 || height == 0 {
        return None;
    }
    for divisor in [1, 2] {
        let ris = (width.div_ceil(divisor), height.div_ceil(divisor));
        let bytes = (u64::from(width) * u64::from(height))
            .checked_mul(60)?
            .checked_add((u64::from(ris.0) * u64::from(ris.1)).checked_mul(132)?)?
            .checked_add(4096)?;
        if bytes <= budget {
            return Some(Resolution {
                full: (width, height),
                ris,
                bytes,
            });
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_hd_uses_half_ris_with_full_material_buffer() {
        let r = resolution(1920, 1080).unwrap();
        assert_eq!(r.ris, (960, 540));
        assert_eq!(r.full, (1920, 1080));
        assert_eq!(r.bytes, 192_848_896);
        assert!(r.bytes < BUDGET_BYTES);
        assert_eq!(resolution(1280, 720).unwrap().ris, (1280, 720));
    }
    #[test]
    fn odd_sizes_resize_and_budget_are_deterministic() {
        let odd = resolution(1921, 1081).unwrap();
        assert_eq!(odd.ris, (961, 541));
        assert_ne!(odd, resolution(1920, 1080).unwrap());
        assert!(resolution(3840, 2160).is_none());
        assert!(resolution(0, 10).is_none());
        assert!(resolution(u32::MAX, u32::MAX).is_none());
        assert_eq!(
            plan(5, 3, 5 * 3 * 60 + 3 * 2 * 132 + 4096).unwrap().ris,
            (3, 2)
        );
        assert!(plan(5, 3, 5 * 3 * 60 + 3 * 2 * 132 + 4095).is_none());
    }
}
