//! Numerical surface assertions for the neutral kernel oracle.
use super::*;

pub(super) fn decoded_surfaces(words: &[f32]) -> Vec<MegaSurfaceRow> {
    words
        .chunks_exact(12)
        .map(|row| {
            std::array::from_fn(|vec4| std::array::from_fn(|slot| f64::from(row[vec4 * 4 + slot])))
        })
        .collect()
}

pub(super) fn assert_surfaces(
    zones: &[Zone],
    surfaces_out: &[f32],
    mirror_surfaces: &[MegaSurfaceRow],
    depth: &[f32],
) -> f64 {
    // 对拍 1:重建表面 vs 镜像(词 ≤0.002;背景零表面全零;边缘带豁免)。
    let surfaces_budget = 0.002f64;
    let mut worst_surface = 0.0f64;
    for pixel in 0..PIXELS {
        let mirror = mirror_surfaces[pixel];
        for vec4 in 0..3 {
            for slot in 0..4 {
                let actual = f64::from(surfaces_out[pixel * 12 + vec4 * 4 + slot]);
                match zones[pixel] {
                    Zone::Background => {
                        assert_eq!(actual, 0.0, "背景像素 {pixel} 表面必须全零");
                    }
                    Zone::Covered => {
                        worst_surface = worst_surface.max((actual - mirror[vec4][slot]).abs());
                    }
                    Zone::Skip => {}
                }
            }
        }
    }
    #[allow(clippy::match_like_matches_macro)]
    for probe_pixel in 0..PIXELS {
        if zones[probe_pixel] != Zone::Covered {
            continue;
        }
        let px = probe_pixel as u32 % WIDTH;
        let py = probe_pixel as u32 / WIDTH;
        eprintln!(
            "pixel({px},{py}) zones_row={:?}",
            ((py.saturating_sub(1))..=(py + 1).min(HEIGHT - 1))
                .map(|y| (y * WIDTH + px) as usize)
                .map(|i| match zones[i] {
                    Zone::Covered => 'C',
                    Zone::Skip => 'S',
                    Zone::Background => '.',
                })
                .collect::<String>()
        );
        eprintln!(
            "  gpu  = {:?}",
            &surfaces_out[probe_pixel * 12..probe_pixel * 12 + 12]
        );
        eprintln!(
            "  mir  = {:?}",
            mirror_surfaces[probe_pixel].map(|v| v.map(|w| w as f32))
        );
        eprintln!(
            "  depth neighborhood = {:?}",
            ((py.saturating_sub(1))..=(py + 1).min(HEIGHT - 1))
                .map(|y| ((px.saturating_sub(1))..=(px + 1).min(WIDTH - 1))
                    .map(|x| depth[(y * WIDTH + x) as usize])
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>()
        );
        break;
    }

    assert!(
        worst_surface <= surfaces_budget,
        "重建表面词最大误差 {worst_surface} 超预算 {surfaces_budget}"
    );
    worst_surface
}

pub(super) fn assert_composite(
    composited: &[f32],
    seed_words: &[f32],
    frame1_out: &[f32],
    frame2_out: &[f32],
) -> f64 {
    let composite_budget = 0.01f64;
    let mut worst_composite = 0.0f64;
    for pixel in 0..PIXELS {
        let alpha_out = composited[pixel * 4 + 3];
        assert_eq!(
            alpha_out,
            f16_to_f32(f32_to_f16_bits(seed_words[pixel * 4 + 3])),
            "像素 {pixel} alpha 逐位不变"
        );
        for channel in 0..3 {
            let seed = f64::from(f16_to_f32(f32_to_f16_bits(seed_words[pixel * 4 + channel])));
            let index = pixel * 4 + channel;
            let first = f16_to_f32(f32_to_f16_bits(seed as f32 + frame1_out[index]));
            let expected = f64::from(f16_to_f32(f32_to_f16_bits(first + frame2_out[index])));
            let actual = f64::from(composited[pixel * 4 + channel]);
            worst_composite = worst_composite.max((actual - expected).abs());
        }
    }
    assert!(
        worst_composite <= composite_budget,
        "加性合成最大误差 {worst_composite} 超 f16 落点预算 {composite_budget}"
    );

    worst_composite
}
