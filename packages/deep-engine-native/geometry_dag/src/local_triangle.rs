//! 局部三角形打包:三个 8-bit 局部索引压入一个 u32(与 TS `localTriangle.ts` 逐位一致)。

use crate::error::{DagError, DagResult};

/// 打包三个局部顶点索引为 `a | (b << 8) | (c << 16)`。
///
/// # Errors
/// 任一索引不在 `0..=255` 时返回 [`DagError::InvalidInput`]。
pub fn pack_local_triangle(a: u32, b: u32, c: u32) -> DagResult<u32> {
    for (name, value) in [("a", a), ("b", b), ("c", c)] {
        if value > 0xff {
            return Err(DagError::invalid_input(format!(
                "Local meshlet indices must fit in eight bits; {name} = {value}."
            )));
        }
    }
    Ok(a | (b << 8) | (c << 16))
}

/// 解包局部三角形为 `[a, b, c]`。
///
/// # Errors
/// 高 8 位非零时返回 [`DagError::InvalidInput`]。
pub fn unpack_local_triangle(packed: u32) -> DagResult<[u8; 3]> {
    if packed > 0x00ff_ffff {
        return Err(DagError::invalid_input(
            "Packed local triangle must use only its low 24 bits.",
        ));
    }
    Ok([
        (packed & 0xff) as u8,
        ((packed >> 8) & 0xff) as u8,
        ((packed >> 16) & 0xff) as u8,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_roundtrips() {
        for a in [0u32, 1, 63, 127, 255] {
            for b in [0u32, 42, 255] {
                for c in [0u32, 7, 255] {
                    let packed = pack_local_triangle(a, b, c).expect("valid indices");
                    assert_eq!(unpack_local_triangle(packed).expect("valid packed"), [a as u8, b as u8, c as u8]);
                }
            }
        }
    }

    #[test]
    fn pack_rejects_out_of_range() {
        assert!(pack_local_triangle(256, 0, 0).is_err());
        assert!(pack_local_triangle(0, u32::MAX, 0).is_err());
    }

    #[test]
    fn unpack_rejects_dirty_high_bits() {
        assert!(unpack_local_triangle(0x0100_0000).is_err());
        assert!(unpack_local_triangle(u32::MAX).is_err());
    }
}
