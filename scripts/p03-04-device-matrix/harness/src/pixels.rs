//! Pixel identity, letterbox metrics, and cross-backend differences.
use super::*;

pub(super) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 与 bin 侧 harness 相同的 letterbox 映射（shader 语义：min-axis 等比 + 居中）。
pub(super) fn letterbox_region(
    rect: [f64; 4],
    page: [f64; 2],
    physical: (u32, u32),
) -> (i64, i64, i64, i64) {
    let scale = (f64::from(physical.0) / page[0]).min(f64::from(physical.1) / page[1]);
    let ox = (f64::from(physical.0) - page[0] * scale) / 2.;
    let oy = (f64::from(physical.1) - page[1] * scale) / 2.;
    let x0 = (ox + rect[0] * scale).floor().max(0.) as i64;
    let y0 = (oy + rect[1] * scale).floor().max(0.) as i64;
    let x1 = (ox + (rect[0] + rect[2]) * scale)
        .ceil()
        .min(f64::from(physical.0)) as i64;
    let y1 = (oy + (rect[1] + rect[3]) * scale)
        .ceil()
        .min(f64::from(physical.1)) as i64;
    (x0, y0, x1, y1)
}

pub(super) fn colored_in_region(
    pixels: &[u8],
    physical: (u32, u32),
    region: (i64, i64, i64, i64),
) -> usize {
    let (x0, y0, x1, y1) = region;
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| ((y as u32 * physical.0 + x as u32) * 4) as usize))
        .filter(|i| pixels[*i] != 0 || pixels[*i + 1] != 0 || pixels[*i + 2] != 0)
        .count()
}

/// letterbox bar 区：按几何只取与内容区 [oy, oy+Hs) / [ox, ox+Ws) 无交集的
/// 整行/整列带（半覆盖边缘行不属于 bar），bar 内必须全是清屏色 [0,0,0,0]。
pub(super) fn bar_bands(
    physical: (u32, u32),
    page: [f64; 2],
) -> (Vec<(i64, i64, i64, i64)>, usize) {
    let (pw, ph) = (i64::from(physical.0), i64::from(physical.1));
    let scale = (f64::from(physical.0) / page[0]).min(f64::from(physical.1) / page[1]);
    let ox = (f64::from(physical.0) - page[0] * scale) / 2.;
    let oy = (f64::from(physical.1) - page[1] * scale) / 2.;
    let mut bands = Vec::new();
    let top = (oy.floor() as i64).min(ph);
    if top > 0 {
        bands.push((0, 0, pw, top));
    }
    let bottom = (oy + page[1] * scale).ceil() as i64;
    if bottom < ph {
        bands.push((0, bottom, pw, ph));
    }
    let left = (ox.floor() as i64).min(pw);
    if left > 0 {
        bands.push((0, 0, left, ph));
    }
    let right = (ox + page[0] * scale).ceil() as i64;
    if right < pw {
        bands.push((right, 0, pw, ph));
    }
    let total: i64 = bands
        .iter()
        .map(|(x0, y0, x1, y1)| (x1 - x0) * (y1 - y0))
        .sum();
    (bands, total.max(0) as usize)
}

pub(super) fn violations_in_bands(
    pixels: &[u8],
    physical: (u32, u32),
    bands: &[(i64, i64, i64, i64)],
) -> usize {
    // 只判 RGB：deep2d 管线的读回 alpha 平面全帧统一为 1（不透明呈现语义），
    // 不携带内容信息；bar 的内容语义 = 无颜色墨迹。
    let mut violations = 0usize;
    for &(x0, y0, x1, y1) in bands {
        for y in y0..y1 {
            for x in x0..x1 {
                let i = ((y as u32 * physical.0 + x as u32) * 4) as usize;
                if pixels[i] != 0 || pixels[i + 1] != 0 || pixels[i + 2] != 0 {
                    violations += 1;
                }
            }
        }
    }
    violations
}

pub(super) fn pixel_stats(pixels: &[u8]) -> (usize, usize, String) {
    let mut colored = 0usize;
    let mut ink = 0usize;
    for pixel in pixels.chunks_exact(4) {
        if pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0 {
            colored += 1;
        }
        if pixel[3] >= 128 {
            ink += 1;
        }
    }
    (colored, ink, format!("fnv1a64:{:016x}", fnv1a64(pixels)))
}

pub(super) struct DiffReport {
    pub(super) diff_pixels: usize,
    pub(super) max_delta: u32,
    pub(super) bbox: [i64; 4],
    pub(super) thresholds: Value,
}

/// 逐像素 diff（RGBA 各通道取最大差），输出阈值直方图与放大掩膜。
pub(super) fn diff_pixels(
    a: &[u8],
    b: &[u8],
    physical: (u32, u32),
    out: &Path,
    name: &str,
) -> Result<DiffReport, String> {
    if a.len() != b.len() {
        return Err(format!("length mismatch {} vs {}", a.len(), b.len()));
    }
    let mut diff_count = 0usize;
    let mut max_delta = 0u32;
    let mut bbox = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
    let mut thresholds = [0usize; 8]; // >=1,2,4,8,16,32,64,128
    let mut mask = vec![0u8; a.len()];
    for y in 0..i64::from(physical.1) {
        for x in 0..i64::from(physical.0) {
            let i = ((y as u32 * physical.0 + x as u32) * 4) as usize;
            let delta = (0..4)
                .map(|c| (i32::from(a[i + c]) - i32::from(b[i + c])).unsigned_abs())
                .max()
                .unwrap_or(0);
            if delta == 0 {
                continue;
            }
            diff_count += 1;
            max_delta = max_delta.max(delta);
            bbox[0] = bbox[0].min(x);
            bbox[1] = bbox[1].min(y);
            bbox[2] = bbox[2].max(x);
            bbox[3] = bbox[3].max(y);
            for (slot, threshold) in thresholds.iter_mut().zip([1u32, 2, 4, 8, 16, 32, 64, 128]) {
                if delta >= threshold {
                    *slot += 1;
                }
            }
            mask[i] = (delta * 8).min(255) as u8;
            mask[i + 3] = 255;
        }
    }
    let bbox = if diff_count == 0 { [0, 0, 0, 0] } else { bbox };
    std::fs::create_dir_all(out.join("raw")).map_err(|e| e.to_string())?;
    std::fs::write(out.join("raw").join(format!("{name}.rgba")), &mask)
        .map_err(|error| format!("write mask: {error}"))?;
    let names = ["ge1", "ge2", "ge4", "ge8", "ge16", "ge32", "ge64", "ge128"];
    Ok(DiffReport {
        diff_pixels: diff_count,
        max_delta,
        bbox,
        thresholds: json!(
            names
                .iter()
                .zip(thresholds)
                .map(|(n, v)| (n.to_string(), Value::from(v)))
                .collect::<serde_json::Map<String, Value>>()
        ),
    })
}

pub(super) fn write_raw(out: &Path, id: &str, pixels: &[u8]) -> Result<(), String> {
    std::fs::write(out.join("raw").join(format!("{id}.rgba")), pixels)
        .map_err(|error| format!("write raw {id}: {error}"))
}
