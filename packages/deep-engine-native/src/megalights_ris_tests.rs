//! [`crate::megalights_ris`] 单测(RNG 位级锚/蓄水池合同/穷举一致性/可见性/
//! EMA/打包 ABI/通路选择/估计器无偏性;TS megaLightsRisCpu.test.ts 同款口径)。

use crate::megalights_abi::{pack_mega_lights, sha256_of_words, MegaLight, MegaLightKind, MegaSurfaceRow, RisReservoir, MEGA_LIGHT_WORDS};
use crate::megalights_ris::{
    build_reservoir_pass, evaluate_mega_light, finish_reservoir, mega_hash_u32,
    mega_lights_exhaustive_reference, mega_lights_frame, mega_light_range_attenuation,
    mega_light_spot_cone, mega_pixel_seed, mega_random_next, mega_shade_winner,
    mega_surface_decode, mega_target_weight, mega_view_depth, merge_reservoir,
    reuse_and_shade_pass, resolve_direct_lighting_path, RandomStream, DirectLightingPath,
    DirectLightingPathDecision, DirectLightingPathReason, MegaLightsFrameConfig,
    MegaLightsFrameInput, MEGALIGHTS_INVALID_LIGHT,
};


    use super::*;

    // TS 位级锚(2026-10-05 现场由 TS oracle 算出;RNG 是纯整数,必须逐位)。
    #[test]
    fn rng_matches_ts_bit_level_anchors() {
        assert_eq!(mega_hash_u32(0), 3232319850);
        assert_eq!(mega_hash_u32(1), 663891101);
        assert_eq!(mega_hash_u32(0xdead_beef), 1462664237);
        assert_eq!(mega_pixel_seed(1, 1, 0), 1570135196);
        assert_eq!(mega_pixel_seed(2, 1, 0), 1952989636);
        assert_eq!(mega_pixel_seed(1, 2, 0), 3816957703);
        assert_eq!(mega_pixel_seed(1, 1, 1), 541657809);
        assert_eq!(mega_pixel_seed(0, 0, 0), 1125925706);
        let (state, value) = mega_random_next(1);
        assert_eq!(state, 3639132858);
        assert_eq!(value, 0.8473004582338035);
        let mut stream = RandomStream::open(5, 3, 0);
        let values: [f64; 4] = std::array::from_fn(|_| stream.next());
        assert_eq!(stream.state, 3643759212);
        assert_eq!(values[0], 0.7639422612264752);
        assert_eq!(values[1], 0.0205720835365355);
        assert_eq!(values[2], 0.5341061989311129);
        assert_eq!(values[3], 0.8483766901772469);
    }

    /// 平面场景构造:8×6 像素,normal [0,1,0] 精确单位;两块深度断裂区
    /// (前景/背景)驱动时域/空间门分支;柱面行法线 [±0.6,0.8,0](精确)
    /// 驱动空间法线门失败分支。
    pub(crate) fn golden_surfaces(width: u32, height: u32) -> Vec<MegaSurfaceRow> {
        let mut surfaces = Vec::with_capacity((width * height) as usize);
        for y in 0..height {
            for x in 0..width {
                let foreground = (x as u32) < width / 2;
                let depth = if foreground { 2.0 } else { 4.0 };
                let cylinder_row = y == height - 1;
                let normal: [f64; 3] = if cylinder_row {
                    if x % 2 == 0 {
                        [0.6, 0.8, 0.0]
                    } else {
                        [-0.6, 0.8, 0.0]
                    }
                } else {
                    [0.0, 1.0, 0.0]
                };
                let position = [
                    f64::from(x) * 0.5 - f64::from(width) * 0.25,
                    depth,
                    f64::from(y) * 0.5 - f64::from(height) * 0.25,
                ];
                surfaces.push([
                    [position[0], position[1], position[2], if (x + y) % 3 == 0 { 1.0 } else { 0.0 }],
                    [normal[0], normal[1], normal[2], if (x * 7 + y) % 2 == 0 { 0.45 } else { 0.2 }],
                    [0.8, 0.7, 0.6, 0.0],
                ]);
            }
        }
        surfaces
    }

    pub(crate) fn golden_lights() -> Vec<MegaLight> {
        let point = |position: [f64; 3], range: f64, intensity: f64, decay: f64| MegaLight {
            kind: MegaLightKind::Point,
            position_view: position,
            range,
            color: [1.0, 0.9, 0.8],
            intensity,
            decay,
            ..MegaLight::default()
        };
        let spot = |position: [f64; 3], inner: f64, outer: f64| MegaLight {
            kind: MegaLightKind::Spot,
            position_view: position,
            range: 8.0,
            color: [0.9, 0.6, 1.0],
            intensity: 6.0,
            decay: 2.0,
            direction_view: [0.0, -1.0, 0.0],
            inner_cone_cos: inner,
            outer_cone_cos: outer,
            ..MegaLight::default()
        };
        vec![
            point([1.0, 3.0, 0.0], 0.0, 4.0, 2.0),
            point([-2.0, 2.5, 1.0], 10.0, 3.0, 2.0),
            point([3.0, 4.0, -1.0], 5.0, 2.0, 3.0),
            point([0.0, 6.0, 2.0], 0.0, 1.5, 2.0),
            point([-1.0, 2.0, 3.0], 4.0, 5.0, 2.5),
            spot([0.5, 4.0, 0.0], 0.9, 0.5),
            spot([-1.5, 5.0, 1.0], 0.8, 0.8), // inner == outer → coneScale = 0 分支
            spot([2.0, 3.5, 2.0], 0.95, 0.3),
            spot([1.0, 2.0, -2.0], 0.7, 0.2),
            MegaLight {
                kind: MegaLightKind::AreaRect,
                position_view: [0.0, 5.0, 0.0],
                range: 0.0,
                color: [1.0, 1.0, 1.0],
                intensity: 2.0,
                decay: 2.0,
                direction_view: [0.0, -1.0, 0.0],
                half_extent: [0.5, 0.25],
                two_sided: false,
                ..MegaLight::default()
            },
            MegaLight {
                kind: MegaLightKind::AreaRect,
                position_view: [-2.0, 4.0, 1.0],
                range: 12.0,
                color: [0.5, 0.8, 1.0],
                intensity: 3.0,
                decay: 2.0,
                direction_view: [0.0, -1.0, 0.0],
                half_extent: [0.75, 0.5],
                two_sided: true,
                ..MegaLight::default()
            },
            MegaLight {
                kind: MegaLightKind::AreaRect,
                position_view: [3.0, 2.0, 0.0],
                range: 6.0,
                color: [1.0, 0.4, 0.2],
                intensity: 4.0,
                decay: 2.0,
                direction_view: [0.0, -1.0, 0.0],
                half_extent: [0.25, 0.25],
                two_sided: false,
                ..MegaLight::default()
            },
        ]
    }

    fn frame_input<'a>(
        lights: &'a [MegaLight],
        surfaces: &'a [MegaSurfaceRow],
        _width: u32,
        _height: u32,
        config: MegaLightsFrameConfig,
        previous: Option<&'a [RisReservoir]>,
        motion_uv: Option<&'a [f64]>,
        previous_color: Option<&'a [f32]>,
        visibility: Option<&'a [f32]>,
        frame: u32,
    ) -> MegaLightsFrameInput<'a> {
        MegaLightsFrameInput {
            lights,
            surfaces,
            previous,
            motion_uv,
            previous_color,
            visibility,
            frame,
            config,
        }
    }

    #[test]
    fn exhaustive_mode_equals_sum_over_lights_pixelwise() {
        let lights = golden_lights();
        let width = 8;
        let height = 6;
        let surfaces = golden_surfaces(width, height);
        let mut config = MegaLightsFrameConfig::new(width, height);
        config.exhaustive = true;
        let input = frame_input(&lights, &surfaces, width, height, config, None, None, None, None, 7);
        let output = mega_lights_frame(&input);
        let reference = mega_lights_exhaustive_reference(&lights, &surfaces, width, height);
        assert!(output.color.iter().any(|value| *value != 0.0), "golden scene must be lit");
        for index in 0..output.color.len() {
            let a = f64::from(output.color[index]);
            let b = f64::from(reference[index]);
            assert!((a - b).abs() <= 1e-9 * f64::max(1.0, b.abs()), "exhaustive mismatch at {index}: {a} vs {b}");
        }
    }

    #[test]
    fn ris_is_deterministic_and_frame_seeded() {
        let lights = golden_lights();
        let width = 8;
        let height = 6;
        let surfaces = golden_surfaces(width, height);
        let input = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), None, None, None, None, 11);
        let first = mega_lights_frame(&input);
        let second = mega_lights_frame(&input);
        assert_eq!(first.color, second.color);
        assert_eq!(first.reservoirs, second.reservoirs);
        let other_frame = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), None, None, None, None, 12);
        let third = mega_lights_frame(&other_frame);
        assert_ne!(first.color, third.color, "frame seed must decorrelate frames");
    }

    #[test]
    fn visibility_mask_scales_shade_side_only() {
        let lights = golden_lights();
        let width = 8;
        let height = 6;
        let surfaces = golden_surfaces(width, height);
        let base = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), None, None, None, None, 3);
        let lit = mega_lights_frame(&base);
        let mut mask = vec![1.0f32; (width * height) as usize];
        mask[..8].fill(0.0);
        let occluded_input = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), None, None, None, Some(&mask), 3);
        let darkened = mega_lights_frame(&occluded_input);
        for pixel in 0..8usize {
            for channel in 0..3 {
                assert_eq!(darkened.color[pixel * 3 + channel], 0.0, "masked pixel must go black");
            }
        }
        for pixel in 8..(width * height) as usize {
            // 未遮挡像素在空间平均源跨到被遮挡源时也会变暗——只断言仍被点亮。
            assert!(darkened.color[pixel * 3..pixel * 3 + 3].iter().any(|value| *value != 0.0));
        }
        let _ = lit;
    }

    #[test]
    fn temporal_reuse_and_ema_reduce_frame_to_frame_variance() {
        let lights = golden_lights();
        let width = 8;
        let height = 6;
        let surfaces = golden_surfaces(width, height);
        let first_input = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), None, None, None, None, 20);
        let first = mega_lights_frame(&first_input);
        let motion = vec![0.25f64; (width * height * 2) as usize];
        let second_input = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), Some(&first.reservoirs), Some(&motion), Some(&first.color), None, 21);
        let second = mega_lights_frame(&second_input);
        // EMA(alpha=1/32)必须把输出拉向历史:帧间颜色差被压缩。
        let mut motion_delta = 0.0f64;
        for index in 0..second.color.len() {
            motion_delta += f64::from(second.color[index]) - f64::from(first.color[index]);
        }
        assert!(motion_delta.abs() > 0.0, "EMA must keep tracking the live estimate");
        // 与无 EMA 的独立帧相比,EMA 帧更贴近历史(平滑生效)。
        let raw_input = frame_input(&lights, &surfaces, width, height, MegaLightsFrameConfig::new(width, height), Some(&first.reservoirs), Some(&motion), None, None, 21);
        let raw = mega_lights_frame(&raw_input);
        let mut ema_distance = 0.0f64;
        let mut raw_distance = 0.0f64;
        for index in 0..second.color.len() {
            ema_distance += (f64::from(second.color[index]) - f64::from(first.color[index])).abs();
            raw_distance += (f64::from(raw.color[index]) - f64::from(first.color[index])).abs();
        }
        assert!(ema_distance < raw_distance, "EMA must smooth temporal noise ({ema_distance} vs {raw_distance})");
    }

    #[test]
    fn reservoir_merge_semantics_match_ts_contract() {
        let mut reservoir = RisReservoir::default();
        merge_reservoir(&mut reservoir, 2.0, 5, 1, 0.5);
        assert_eq!(reservoir, RisReservoir { weight_sum: 2.0, winner: 5, m: 1 });
        merge_reservoir(&mut reservoir, 100.0, 7, 1, 0.9);
        assert_eq!(reservoir.winner, 7);
        assert!((reservoir.weight_sum - 102.0).abs() < 1e-12);
        // 零权/零计数合并为 no-op(TS 同式)。
        let snapshot = reservoir;
        merge_reservoir(&mut reservoir, 0.0, 9, 1, 0.0);
        merge_reservoir(&mut reservoir, 5.0, 9, 0, 0.0);
        assert_eq!(reservoir, snapshot);
        // 多候选合并(count>1 带权)。
        let mut multi = RisReservoir::default();
        merge_reservoir(&mut multi, 3.0, 1, 3, 0.5);
        assert_eq!(multi, RisReservoir { weight_sum: 9.0, winner: 1, m: 3 });
    }

    /// RIS 估计器无偏性(TS megaLightsRisCpu.test 同款口径:buildScene(64)
    /// 黄金角点光 + 单像素 256 帧均值 vs 精确和 ≤5%)。
    #[test]
    fn ris_estimator_unbiased_over_independent_seeds() {
        let lights: Vec<MegaLight> = (0..64)
            .map(|index| {
                let angle = index as f64 * 2.399_963_229_728_653;
                let radius = 2.0 + (index % 7) as f64 * 0.9;
                let intensity = 0.6 + (index % 5) as f64 * 0.5;
                MegaLight {
                    kind: MegaLightKind::Point,
                    position_view: [f64::cos(angle) * radius, f64::sin(angle) * radius, 2.0 + (index % 3) as f64],
                    range: 0.0,
                    color: [1.0, 0.95 - (index % 4) as f64 * 0.1, 0.9 - (index % 3) as f64 * 0.15],
                    intensity,
                    decay: 2.0,
                    ..MegaLight::default()
                }
            })
            .collect();
        let surface: MegaSurfaceRow = [
            [-0.4, -0.4, -3.5, 0.0],
            [0.0, 0.0, 1.0, 0.5],
            [0.8, 0.8, 0.8, 0.0],
        ];
        let exact: [f64; 3] = lights.iter().fold([0.0; 3], |mut sum, light| {
            let c = evaluate_mega_light(light, &surface);
            sum[0] += c[0];
            sum[1] += c[1];
            sum[2] += c[2];
            sum
        });
        let frames = 256;
        let surfaces = [surface];
        let mut total = [0.0f64; 3];
        for frame in 0..frames {
            let mut config = MegaLightsFrameConfig::new(1, 1);
            config.temporal = false;
            config.spatial = false;
            let input = MegaLightsFrameInput {
                lights: &lights,
                surfaces: &surfaces,
                previous: None,
                motion_uv: None,
                previous_color: None,
                visibility: None,
                frame,
                config,
            };
            let output = mega_lights_frame(&input);
            total[0] += f64::from(output.color[0]);
            total[1] += f64::from(output.color[1]);
            total[2] += f64::from(output.color[2]);
        }
        for channel in 0..3 {
            let mean = total[channel] / f64::from(frames);
            assert!(
                (mean - exact[channel]).abs() < 0.05 * f64::max(1.0, exact[channel]),
                "channel {channel} mean {mean} deviates from exact {} beyond 5%",
                exact[channel]
            );
        }
    }

    #[test]
    fn direct_lighting_path_matches_ts_vocabulary() {
        assert_eq!(
            resolve_direct_lighting_path(40, 30, 4, false, None),
            DirectLightingPathDecision {
                path: DirectLightingPath::MegalightsRis,
                reason: DirectLightingPathReason::LightCountExceedsClusterBudget,
                local_light_count: 70,
                area_count: 4,
            }
        );
        assert_eq!(
            resolve_direct_lighting_path(10, 20, 4, false, None),
            DirectLightingPathDecision {
                path: DirectLightingPath::ClusterForwardPlus,
                reason: DirectLightingPathReason::WithinClusterBudget,
                local_light_count: 30,
                area_count: 4,
            }
        );
        assert_eq!(
            resolve_direct_lighting_path(1, 1, 0, true, None).reason,
            DirectLightingPathReason::MegalightsForced
        );
    }

    #[test]
    fn packing_matches_abi_layout_and_counts() {
        let lights = golden_lights();
        let packed = pack_mega_lights(&lights);
        assert_eq!(packed.count, 12);
        assert_eq!(packed.point_count, 5);
        assert_eq!(packed.spot_count, 4);
        assert_eq!(packed.area_count, 3);
        assert_eq!(packed.data.len(), 12 * MEGA_LIGHT_WORDS);
        // kind 词(f32 精确整数)。
        assert_eq!(packed.data[3], 0.0);
        assert_eq!(packed.data[5 * MEGA_LIGHT_WORDS + 3], 1.0);
        assert_eq!(packed.data[9 * MEGA_LIGHT_WORDS + 3], 2.0);
        // point 分支 [decay-2,0,0,0] 在 base+12;spot decay-2 在 base+15。
        assert_eq!(packed.data[15], 0.0); // decay 2 → 0
        assert_eq!(packed.data[2 * MEGA_LIGHT_WORDS + 12], 1.0); // decay 3 → 1
        assert_eq!(packed.data[2 * MEGA_LIGHT_WORDS + 15], 0.0);
        assert_eq!(packed.data[7 * MEGA_LIGHT_WORDS + 15], 0.0); // spot decay 2 → 0
        assert_eq!(packed.data[6 * MEGA_LIGHT_WORDS + 14], 0.0); // inner==outer → coneScale 0
        assert_eq!(packed.data[10 * MEGA_LIGHT_WORDS + 14], 1.0); // twoSided
        // 无灯最小占位:1 灯槽全零。
        let empty = pack_mega_lights(&[]);
        assert_eq!(empty.data.len(), MEGA_LIGHT_WORDS);
        assert!(empty.data.iter().all(|word| *word == 0.0));
        // SHA-256 指纹确定性(词流 LE;fixture 生成器同式)。
        assert_eq!(sha256_of_words(&packed.data), sha256_of_words(&pack_mega_lights(&lights).data));
    }

