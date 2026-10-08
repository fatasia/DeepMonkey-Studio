//! Legacy neutral reconstruction/RIS kernel oracle. Actual production GBuffer/TLAS
//! coverage lives in megalights_material_gpu_tests.
#[path = "megalights_probe_fixture.rs"] mod fixture;
#[path = "megalights_probe_io.rs"] mod io;
#[path = "megalights_probe_targets.rs"] mod targets;
#[path = "megalights_probe_assertions.rs"] mod assertions;
use fixture::*;
use io::*;
use deep_engine_native::megalights_abi::pack_mega_lights;
use deep_engine_native::megalights_ris::{
    MegaLight, MegaLightKind, MegaLightsFrameConfig, MegaLightsFrameInput, MegaSurfaceRow,
    mega_lights_frame,
};
use deep_engine_native::mesh_abi::{CAMERA_FAR, CAMERA_FOCAL, CAMERA_NEAR, FORWARD_SAMPLE_COUNT};
use deep_engine_native::player_view::PlayerView;

use super::megalights_gpu::MegaLightsGpuChain;

const WIDTH: u32 = 16;
const HEIGHT: u32 = 12;
const PIXELS: usize = (WIDTH * HEIGHT) as usize;
/// 斜面定义(view 系):z(x) = −3 − 0.006x。斜率取小值是刻意的:重建核的
/// MSAA-min 深度语义(像素内最近样本)与 TS 1x 中心采样在斜面上有系统性
/// 深度差,而深度→视距映射在远处极敏感(dd/dz ≈ near⁻¹·d²/near ≈ 147),
/// 0.6 斜率下样本深度散布 ~1e-3 → 视距漂移 ~0.15(8%);0.006 斜率把该
/// 语义差压到 ~1.5e-3 < 0.002 预算,同时保持差分法线非零(≥1 节距的
/// x 向深度梯度仍高出量化底噪 3 个量级)。
const PLANE_SLOPE: f64 = 0.006;
/// 斜面 (x,y) 覆盖域(view 系)与内缩余量(光栅化边缘过渡带豁免)。域按
/// 像素节距(z=−3 处 ≈0.244 view 单位)推导:内缩带 = 覆盖区(像素及其
/// 右/下邻域全部样本在斜面内,≥1 节距),域外扩 1 节距之外 = 背景区
/// (零样本命中),之间 = Skip(MSAA 样本级覆盖过渡带,如实豁免)。
const PLANE_X: (f64, f64) = (-1.9, 1.9);
const PLANE_Y: (f64, f64) = (-0.85, 0.85);
const EDGE_MARGIN: f64 = 0.25;

/// 生产链真机腿:重建核 → RIS 两帧全链 → 加性合成,四段同批对拍。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn megalights_production_chain_rebuild_ris_composite_matches_mirror() {
    pollster::block_on(async {
        let aspect = WIDTH as f32 / HEIGHT as f32;
        let view = camera();
        let projection = view_projection(view, aspect);
        let combined = super::megalights_gpu::combined_clip_to_view(view, &projection)
            .expect("camera must be invertible");

        // 期望侧:解析斜面 → 覆盖三区 + NDC 深度图案。
        let mut depth = vec![1.0f32; PIXELS];
        let mut zones = vec![Zone::Background; PIXELS];
        for py in 0..HEIGHT {
            for px in 0..WIDTH {
                let (zone, hit) = plane_hit(view, aspect, px, py);
                let index = (py * WIDTH + px) as usize;
                zones[index] = zone;
                if let Some(point) = hit {
                    depth[index] = ndc_depth(&projection, view, point);
                }
            }
        }
        let covered = zones.iter().filter(|zone| **zone == Zone::Covered).count();
        let background = zones.iter().filter(|zone| **zone == Zone::Background).count();
        assert!(covered >= 8, "场景必须含覆盖区(实际 {covered})");
        assert!(background >= 8, "场景必须含背景区(实际 {background})");
        #[allow(clippy::duplicate_mod)]
        {
            eprintln!("zones: {:?}", zones.iter().map(|z| match z {
                Zone::Covered => 'C',
                Zone::Skip => 'S',
                Zone::Background => '.',
            }).collect::<String>());
        }
        let mirror_surfaces = reference_surfaces(&depth, &combined);

        // GPU 面:设备 + error scope(全程覆盖)。
        let (device, queue) = gpu_device().await;
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);

        let (depth_texture, hdr, seed_words) = targets::prepare_targets(&device, &queue, view, &projection);
        let depth_view = depth_texture.create_view(&Default::default());
        let hdr_view = hdr.create_view(&Default::default());

        // 生产链(与 frame.rs 同编排)帧 1:α=1 首帧全量。
        let lights = fixture_lights();
        let packed = pack_mega_lights(&lights);
        let mut chain = MegaLightsGpuChain::create(&device, &depth_view, None, WIDTH, HEIGHT, 1)
            .expect("production chain must build");
        // 灯池扩容(生产 encode_gpu_frame 的 ensure 路径同款)。
        chain.grow_lights(&device, &queue, packed.data.len());
        let make_input = |alpha: f32, seed: u32| super::megalights_gpu::MegaLightsGpuFrameInput {
            view,
            frame_view_projection: &projection,
            packed_words: &packed.data,
            light_count: packed.count as u32,
            shadow_mask: 0,
            ies: None,
            frame_seed: seed,
            alpha_blend: alpha,
            exhaustive: true,
            hdr_view: &hdr_view,
            msaa_view: None, exposure: 1.0,
        };
        {
            let mut encoder = device.create_command_encoder(&Default::default());
            chain.encode_frame(&queue, &mut encoder, &make_input(1.0, 44));
            queue.submit(Some(encoder.finish()));
        }
        let frame1_out = readback_buffer(&device, &queue, chain.probe_buffers()[2], PIXELS * 4);

        // 帧 2:α=1/32(蓄水池 B/颜色历史跨帧驻留 → 时域链)。
        {
            let mut encoder = device.create_command_encoder(&Default::default());
            chain.encode_frame(&queue, &mut encoder, &make_input(1.0 / 32.0, 45));
            queue.submit(Some(encoder.finish()));
        }
        let frame2_out = readback_buffer(&device, &queue, chain.probe_buffers()[2], PIXELS * 4);
        let reservoirs_out = readback_buffer(&device, &queue, chain.probe_buffers()[1], PIXELS * 4);
        let surfaces_out = readback_buffer(&device, &queue, chain.probe_buffers()[4], PIXELS * 12);
        let composited = readback_hdr(&device, &queue, &hdr);

        let gpu_errors = [internal.pop().await, memory.pop().await, validation.pop().await];
        assert!(
            gpu_errors.iter().flatten().next().is_none(),
            "生产链 error scope 必须干净: {gpu_errors:?}"
        );

        let worst_surface = assertions::assert_surfaces(&zones, &surfaces_out, &mirror_surfaces, &depth);
        // 对拍 2:CPU 权威两帧(镜像表面;α=1 → α=1/32 链)。
        let make_config = || {
            let mut config = MegaLightsFrameConfig::new(WIDTH, HEIGHT);
            config.exhaustive = true;
            config.temporal = true;
            config.spatial = true;
            config
        };
        let frame1 = mega_lights_frame(&MegaLightsFrameInput {
            lights: &lights,
            surfaces: &mirror_surfaces,
            previous: None,
            motion_uv: None,
            previous_color: None,
            visibility: None,
            ies: None,
            frame: 44,
            config: make_config(),
        });
        let frame2 = mega_lights_frame(&MegaLightsFrameInput {
            lights: &lights,
            surfaces: &mirror_surfaces,
            previous: Some(&frame1.reservoirs),
            motion_uv: None,
            previous_color: Some(&frame1.color),
            visibility: None,
            ies: None,
            frame: 45,
            config: make_config(),
        });
        let color_budget = 0.002f64;
        let mut worst_color = [0.0f64; 2];
        for (frame_index, (gpu, expected)) in
            [(&frame1_out, &frame1.color), (&frame2_out, &frame2.color)].into_iter().enumerate()
        {
            for pixel in 0..PIXELS {
                if zones[pixel] != Zone::Covered {
                    continue;
                }
                for channel in 0..3 {
                    let actual = f64::from(gpu[pixel * 4 + channel]);
                    let expect = f64::from(expected[pixel * 3 + channel]);
                    worst_color[frame_index] = worst_color[frame_index].max((actual - expect).abs());
                }
            }
        }
        for (frame_index, worst) in worst_color.iter().enumerate() {
            assert!(
                *worst <= color_budget,
                "RIS 帧 {} 颜色词最大误差 {worst} 超预算 {color_budget}",
                frame_index + 1
            );
        }

        // 穷举候选两半不同；结构腿用独立随机链、同 RNG 流和同一 GPU 重建表面。
        // 解析表面已有独立精度断言；MSAA 边界不可作为随机逐位 oracle 输入。
        let ris_surfaces = assertions::decoded_surfaces(&surfaces_out);
        let motion_uv = vec![0.0f64; PIXELS * 2];
        let mut rand_chain = MegaLightsGpuChain::create(&device, &depth_view, None, WIDTH, HEIGHT, 1)
            .expect("random chain must build");
        rand_chain.grow_lights(&device, &queue, packed.data.len());
        let rand_input = |alpha: f32, seed: u32| super::megalights_gpu::MegaLightsGpuFrameInput {
            view,
            frame_view_projection: &projection,
            packed_words: &packed.data,
            light_count: packed.count as u32,
            shadow_mask: 0,
            ies: None,
            frame_seed: seed,
            alpha_blend: alpha,
            exhaustive: false,
            hdr_view: &hdr_view,
            msaa_view: None, exposure: 1.0,
        };
        {
            let mut encoder = device.create_command_encoder(&Default::default());
            rand_chain.encode_frame(&queue, &mut encoder, &rand_input(1.0, 44));
            queue.submit(Some(encoder.finish()));
        }
        let rand_frame1_out = readback_buffer(&device, &queue, rand_chain.probe_buffers()[2], PIXELS * 4);
        {
            let mut encoder = device.create_command_encoder(&Default::default());
            rand_chain.encode_frame(&queue, &mut encoder, &rand_input(1.0 / 32.0, 45));
            queue.submit(Some(encoder.finish()));
        }
        let rand_reservoirs_out =
            readback_buffer(&device, &queue, rand_chain.probe_buffers()[1], PIXELS * 4);
        let rand_color_out = readback_buffer(&device, &queue, rand_chain.probe_buffers()[2], PIXELS * 4);
        let mut rand_config = MegaLightsFrameConfig::new(WIDTH, HEIGHT);
        rand_config.exhaustive = false;
        rand_config.temporal = true;
        rand_config.spatial = true;
        let rand_frame1 = mega_lights_frame(&MegaLightsFrameInput {
            lights: &lights,
            surfaces: &ris_surfaces,
            previous: None,
            motion_uv: Some(&motion_uv),
            previous_color: None,
            visibility: None,
            ies: None,
            frame: 44,
            config: rand_config.clone(),
        });
        let rand_frame2 = mega_lights_frame(&MegaLightsFrameInput {
            lights: &lights,
            surfaces: &ris_surfaces,
            previous: Some(&rand_frame1.reservoirs),
            motion_uv: Some(&motion_uv),
            previous_color: Some(&rand_frame1.color),
            visibility: None,
            ies: None,
            frame: 45,
            config: rand_config,
        });
        // 结构腿:随机模式两半同 RNG 流 → winner/m 逐位(lib 随机腿同款)。
        for pixel in 0..PIXELS {
            if zones[pixel] != Zone::Covered {
                continue;
            }
            let gpu_words = &rand_reservoirs_out[pixel * 4..pixel * 4 + 4];
            let cpu = &rand_frame2.reservoirs[pixel];
            let gpu_winner = if gpu_words[1] == 0.0 {
                deep_engine_native::megalights_ris::MEGALIGHTS_INVALID_LIGHT
            } else {
                (gpu_words[1] as u32).wrapping_sub(1)
            };
            assert_eq!(gpu_winner, cpu.winner, "随机腿像素 {pixel} winner 漂移");
            assert_eq!(gpu_words[2] as u32, cpu.m, "随机腿像素 {pixel} m 漂移");
        }
        // 随机链颜色腿:f32 vs f64 评价经蓄水池非线性放大 → 相对 RMSE ≤15%
        // (lib 随机腿同款统计腿;帧 2 含 1/32 EMA 链)。
        for (gpu, expected, label) in [
            (&rand_frame1_out, &rand_frame1.color, "rand frame1"),
            (&rand_color_out, &rand_frame2.color, "rand frame2"),
        ] {
            let mut total = 0.0f64;
            let mut count = 0usize;
            for pixel in 0..PIXELS {
                if zones[pixel] != Zone::Covered {
                    continue;
                }
                for channel in 0..3 {
                    let d = f64::from(gpu[pixel * 4 + channel]) - f64::from(expected[pixel * 3 + channel]);
                    total += d * d;
                    count += 1;
                }
            }
            let error = f64::sqrt(total / count as f64);
            let energy: f64 = expected
                .iter()
                .enumerate()
                .filter(|(index, _)| zones[index / 3] == Zone::Covered)
                .map(|(_, value)| f64::from(value.abs()))
                .sum::<f64>()
                / count as f64;
            assert!(
                error <= f64::max(0.05, energy * 0.15),
                "{label} 相对 RMSE {error} 超 15% 能量包络(energy {energy})"
            );
        }

        // 对拍 4:目标保留两帧加性贡献；f16 每帧舍入，alpha 逐位不变。
        let worst_composite = assertions::assert_composite(&composited, &seed_words, &frame1_out, &frame2_out);

        println!(
            "megalights production chain probe: pixels={PIXELS} surface_worst={worst_surface:.6} \
             color_worst={worst_color:?} composite_worst={worst_composite:.6}"
        );
    });
}
