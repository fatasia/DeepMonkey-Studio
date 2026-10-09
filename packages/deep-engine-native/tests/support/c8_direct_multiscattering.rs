pub(super) use crate::j3_hdr_frame as hdr_frame;
use crate::{
    player_content::PlayerContent,
    shader_material_renderer::{FrameObservation, render_with_frame_observation},
};
use deep_engine_native::{
    half_decode::half_to_f32, pbr_brdf::direct_brdf, player_view::PlayerView,
    runtime_package::parse_and_validate_runtime_package, scene_lighting::DirectionalLighting,
};
use serde_json::{Value, json};
use winit::dpi::PhysicalSize;
pub(super) const PACKAGE: &[u8] = include_bytes!("../fixtures/runtime-package-v1.json");
pub(super) const MANIFEST: &str =
    include_str!("../../../deep-engine/fixtures/j3-hdr-flat-normal-v1.json");
pub(super) fn vector(value: &Value) -> [f32; 3] {
    std::array::from_fn(|i| value[i].as_f64().unwrap() as f32)
}

// golden-copper(runtime-package-v1.json materials[1]);f0 = mix(0.04, base, metal)
// 与 dielectric = 0.04(normal_0.w 走 deepDielectricF0 的 1.5 特例)一致。
pub(super) const BASE_COLOR: [f64; 3] = [0.86, 0.28, 0.055];
pub(super) const METALLIC: f64 = 0.72;
pub(super) const ROUGHNESS: f64 = 0.34;
// C8-S9 冻结的两个 brdf_lut 填充:主填充取 j3 归因常量 [0.75, 0.0625](切换前直射
// 曾误消费它、留下 mr-linear 残差的那个值——回归到旧行为时偏差远超 0.002 门),
// 对照填充取全零。切换后直射与 IBL 资源解耦,两填充必须整帧逐位相等。
pub(super) const FROZEN_DFG_FILL: [f32; 4] = [0.75, 0.0625, 0.0, 1.0];
pub(super) const ZERO_DFG_FILL: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// C8-S9 DFG twin:直接解析共享 WGSL 真源(与装配链同一字节;checksum 门在
/// `lighting_math_wgsl::shared_direct_dfg_lut_185_matches_pinned_checksum_and_hosts`,
/// TS 半在 deep-engine `directDfgLut185.test.ts`)。256 条 vec2f,行=dotNV、列=roughness。
fn deep_direct_dfg_185_table() -> &'static [[f64; 2]; 256] {
    static TABLE: std::sync::OnceLock<[[f64; 2]; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let source = include_str!("../../../deep-engine/wgsl/directDfgLut185.wgsl");
        let mut entries: Vec<[f64; 2]> = Vec::new();
        let mut rest = source;
        while let Some(start) = rest.find("vec2f(") {
            rest = &rest[start + "vec2f(".len()..];
            let end = rest.find(')').expect("shared DFG twin entry must close");
            let (x, y) = rest[..end]
                .split_once(',')
                .expect("shared DFG twin entry holds two scalars");
            entries.push([
                x.trim()
                    .parse()
                    .expect("shared DFG twin x must parse as f64"),
                y.trim()
                    .parse()
                    .expect("shared DFG twin y must parse as f64"),
            ]);
            rest = &rest[end + 1..];
        }
        assert_eq!(
            entries.len(),
            256,
            "shared DFG twin must hold the full 16x16 table"
        );
        // 与 TS canonical 常量(directDfgLut185.ts 解码)的手算锚点一致
        // (j3TextureCoverageParity.test.mjs 同一锚点,三方互锁)。
        assert_eq!(
            entries[15 * 16 + 12],
            [0.5830078125, 0.00010627508163452148]
        );
        entries.try_into().expect("256 entries")
    })
}

/// 逐式镜像 deepDirectDfg185 的 clamp-to-edge 双线性查表(u=roughness 列,v=dotNV 行)。
pub(super) fn direct_dfg_185(roughness: f64, dot_nv: f64) -> [f64; 2] {
    let table = deep_direct_dfg_185_table();
    let u = roughness.clamp(0.0, 1.0) * 16.0 - 0.5;
    let v = dot_nv.clamp(0.0, 1.0) * 16.0 - 0.5;
    let fu0 = u.floor();
    let fv0 = v.floor();
    let i0 = fu0.clamp(0.0, 15.0) as usize;
    let j0 = fv0.clamp(0.0, 15.0) as usize;
    let i1 = (fu0 + 1.0).clamp(0.0, 15.0) as usize;
    let j1 = (fv0 + 1.0).clamp(0.0, 15.0) as usize;
    let fu = (u - fu0).clamp(0.0, 1.0);
    let fv = (v - fv0).clamp(0.0, 1.0);
    let at = |j: usize, i: usize| table[j * 16 + i];
    let (a00, a10, a01, a11) = (at(j0, i0), at(j0, i1), at(j1, i0), at(j1, i1));
    [
        a00[0] * (1.0 - fu) * (1.0 - fv)
            + a10[0] * fu * (1.0 - fv)
            + a01[0] * (1.0 - fu) * fv
            + a11[0] * fu * fv,
        a00[1] * (1.0 - fu) * (1.0 - fv)
            + a10[1] * fu * (1.0 - fv)
            + a01[1] * (1.0 - fu) * fv
            + a11[1] * fu * fv,
    ]
}

/// deepDirectMultiscatteringEnergy 的 CPU 镜像,dfg 来源改为 r185 twin 双查表:
/// dfg_view = dfg185(rough, nv)(宿主 seed/懒采样),dfg_light = dfg185(rough, nl)。
pub(super) fn multiscattering_energy(f0: f64, rough: f64, nv: f64, nl: f64) -> f64 {
    let view = direct_dfg_185(rough, nv);
    let light = direct_dfg_185(rough, nl);
    let single_view = f0 * view[0] + view[1];
    let single_light = f0 * light[0] + light[1];
    let lost_view = 1.0 - (view[0] + view[1]);
    let lost_light = 1.0 - (light[0] + light[1]);
    let average = f0 + (1.0 - f0) * 0.047619;
    single_view * single_light * average / (1.0 - lost_view * lost_light * average + 0.000001)
        * lost_view
        * lost_light
}

/// 128×128 数值附件的逐像素射线,复刻 `frame_data_with_camera` 的 VP 装配
/// (clip.x = focal/aspect·right·(w−eye),clip.y = focal·up·(w−eye),
/// clip.w = forward·(w−eye);128×128 时 aspect=1),打在 z=0 平面上。
/// 返回命中点的 view 方向与 nv。平面是 flat-normal fixture(法线 [0,0,1],
/// 常量插值 → dpdx/dpdy=0,几何粗糙度项为 0)。
pub(super) fn pixel_view_on_ground(view: &PlayerView, pixel: usize, size: u32) -> ([f64; 3], f64) {
    let [right, up, forward] = view.basis();
    let eye = view.eye();
    let focal = f64::from(view.focal);
    let ndc_x = (((pixel % size as usize) as f64 + 0.5) / f64::from(size)) * 2.0 - 1.0;
    let ndc_y = 1.0 - (((pixel / size as usize) as f64 + 0.5) / f64::from(size)) * 2.0;
    let direction: [f64; 3] = std::array::from_fn(|axis| {
        f64::from(forward[axis])
            + (ndc_x / focal) * f64::from(right[axis])
            + (ndc_y / focal) * f64::from(up[axis])
    });
    let s = -f64::from(eye[2]) / direction[2];
    assert!(
        s > 0.0,
        "camera ray must hit the z=0 plane in front of the eye"
    );
    let to_eye: [f64; 3] = direction.map(|axis| -axis * s);
    let length = (to_eye[0] * to_eye[0] + to_eye[1] * to_eye[1] + to_eye[2] * to_eye[2]).sqrt();
    let view_direction = std::array::from_fn(|axis| to_eye[axis] / length);
    (view_direction, view_direction[2])
}

#[test]
#[ignore = "actual production HDR r185-DFG direct differential, two fresh hardware devices"]
fn c8_actual_primary_direct_multiscattering() {
    let output = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-output/interrupted-0930/c8-native-direct-energy");
    std::fs::create_dir_all(&output).unwrap();
    let evidence_path = output.join("evidence.json");
    if let Err(error) = std::fs::remove_file(&evidence_path) {
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
    pollster::block_on(async {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .unwrap();
        let info = adapter.get_info();
        assert!(matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let mut rounds = Vec::new();
        let mut maximum = 0.0_f64;
        for round in 0..2 {
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let mut cases = Vec::new();
            for camera in manifest["cameras"].as_array().unwrap() {
                let view = PlayerView {
                    focal: (1.0 / (camera["verticalFovRadians"].as_f64().unwrap() * 0.5).tan())
                        as f32,
                    near: 0.1,
                    far: 40.0,
                    ..Default::default()
                }
                .with_eye_target(vector(&camera["eye"]), vector(&camera["target"]))
                .unwrap();
                // 每个 mode 渲染两个 brdf_lut 填充:
                // 1) 解耦合同:IBL 已被 frame[9][3]=0 关闭,直射不再消费 brdf_lut,
                //    两填充整帧逐位相等(旧机制靠填充差分隔离多散射,切换后失效);
                // 2) lit − off = 完整直射(单散射 GGX + r185 双查表多散射)·nl·radiance,
                //    GGX 由既有 CPU 参考 direct_brdf 提供。
                let mut lit_hdr = Vec::new();
                let mut off_hdr = Vec::new();
                let mut back_hdr = Vec::new();
                for mode in ["lit", "back", "off"] {
                    let direction = [
                        -0.6,
                        -0.3,
                        if mode == "back" {
                            -0.55_f32.sqrt()
                        } else {
                            0.55_f32.sqrt()
                        },
                    ];
                    let radiance = if mode == "off" {
                        [0.0; 3]
                    } else {
                        [2.5, 2.4, 2.25]
                    };
                    let configure = |frame: &mut deep_engine_native::mesh_abi::FrameUniform| {
                        let light: DirectionalLighting = serde_json::from_value(json!({
                            "direction":direction,"radiance":radiance,"exposure":1.0,"shadows":false
                        }))
                        .unwrap();
                        light.validate().unwrap().apply(frame);
                        frame[9][3] = 0.0;
                    };
                    for dfg in [FROZEN_DFG_FILL, ZERO_DFG_FILL] {
                        let mut content = PlayerContent::from_package(
                            parse_and_validate_runtime_package(PACKAGE).unwrap(),
                        )
                        .unwrap();
                        content.environment.brdf_lut.texels.fill(dfg);
                        let snapshot = render_with_frame_observation(
                            &device,
                            &queue,
                            &content,
                            &mut FrameObservation {
                                capture_normals: false,
                                shadow_options: None,
                                size: PhysicalSize::new(128, 128),
                                view,
                                configure: Some(&configure),
                                encode: &mut |_device, _encoder, targets, _frame, _shadow| {
                                    assert!(targets.resolved_normal_texture().is_none());
                                },
                            },
                        )
                        .await;
                        match mode {
                            "lit" => lit_hdr.push(snapshot.hdr),
                            "back" => back_hdr.push(snapshot.hdr),
                            _ => off_hdr.push(snapshot.hdr),
                        }
                    }
                }
                assert!(
                    lit_hdr[0] == lit_hdr[1],
                    "brdf_lut fill must not reach native direct output (lit)"
                );
                assert!(
                    back_hdr[0] == back_hdr[1],
                    "brdf_lut fill must not reach native direct output (back)"
                );
                assert!(
                    off_hdr[0] == off_hdr[1],
                    "brdf_lut fill must not reach native direct output (off)"
                );
                // 冻结稳定域的法线为 +Z，背光 nl<=0。其余面和 MSAA
                // 轮廓拥有不同法线，不能把该域合同外推为整幅图恒黑。
                let mut samples = Vec::new();
                for subset in camera["subsets"].as_array().unwrap() {
                    for pixel in subset["pixels"].as_array().unwrap() {
                        let pixel = pixel.as_u64().unwrap() as usize;
                        assert!(
                            back_hdr[0][pixel * 8..pixel * 8 + 8]
                                == off_hdr[0][pixel * 8..pixel * 8 + 8],
                            "backlight direct must be zero at frozen stable pixel {pixel}"
                        );
                        let (view_direction, nv) = pixel_view_on_ground(&view, pixel, 128);
                        let nl = 0.55_f64.sqrt();
                        let ggx = direct_brdf(
                            [0.0, 0.0, 1.0],
                            view_direction,
                            [-0.6, -0.3, nl],
                            BASE_COLOR,
                            METALLIC,
                            ROUGHNESS,
                        );
                        let values: Vec<_> = (0..3).map(|lane| {
                            let offset = pixel*8+lane*2;
                            let decode = |bytes: &[u8]| half_to_f32(u16::from_le_bytes([bytes[offset],bytes[offset+1]])) as f64;
                            let lit = decode(&lit_hdr[0]); let off = decode(&off_hdr[0]);
                            let f0 = 0.04 * (1.0 - METALLIC) + BASE_COLOR[lane] * METALLIC;
                            // direct_brdf 已含 nl，多散射能量核尚未含 nl。
                            let expected = (ggx[lane]
                                + multiscattering_energy(f0, ROUGHNESS, nv.clamp(0.001, 1.0), nl) * nl)
                                * RADIANCE[lane];
                            let error = (lit - off - expected).abs();
                            maximum = maximum.max(error);
                            assert!(error <= 0.002, "round={round} camera={} pixel={pixel} lane={lane}: delta={} expected={expected} error={error}", camera["id"].as_str().unwrap(), lit-off);
                            assert!(lit > off, "missing actual direct supplement");
                            json!({"lit":lit,"off":off,"expected":expected,"error":error})
                        }).collect();
                        samples.push(
                            json!({"pixel":pixel,"instance":subset["instanceId"],"rgb":values}),
                        );
                    }
                }
                cases.push(json!({"camera":camera["id"],"samples":samples}));
            }
            device.destroy();
            rounds.push(cases);
        }
        assert_eq!(rounds[0], rounds[1]);
        std::fs::write(&evidence_path, serde_json::to_string_pretty(&json!({
            "passed":true,"stable":true,"freshDevices":2,"actualProductionHdr":true,"adapter":format!("{info:?}"),
            "source":hdr_frame::shader_source(),"maxError":maximum,"budget":0.002,"rounds":rounds,
            "scope":"primary full-direct energy (GGX via pbr_brdf::direct_brdf + r185 twin multiscattering) lit/off differential, brdf_lut fill decoupling, IBL disabled",
            "excluded":["default DFG profile equivalence","RT actual hardware","local lights","complete C8"]
        })).unwrap()).unwrap();
    });
}

pub(super) const RADIANCE: [f64; 3] = [2.5, 2.4, 2.25];

#[test]
fn direct_oracle_view_ray_matches_axis_camera_closed_form() {
    let view = PlayerView::default()
        .with_eye_target([0.0, 0.0, 8.0], [0.0; 3])
        .unwrap();
    for pixel in [6991, 8256, 9814] {
        let x = ((pixel % 128) as f64 + 0.5) / 128.0 * 2.0 - 1.0;
        let y = 1.0 - ((pixel / 128) as f64 + 0.5) / 128.0 * 2.0;
        let unnormalized = [-x / f64::from(view.focal), -y / f64::from(view.focal), 1.0];
        let length = unnormalized.iter().map(|v| v * v).sum::<f64>().sqrt();
        let expected = unnormalized.map(|v| v / length);
        let (actual, nv) = pixel_view_on_ground(&view, pixel, 128);
        for lane in 0..3 {
            assert!((actual[lane] - expected[lane]).abs() < 1e-8);
        }
        assert!((nv - expected[2]).abs() < 1e-8);
    }
}

#[test]
fn direct_dfg_185_twin_matches_shared_wgsl_anchors() {
    // 非 GPU 锚点锁:twin 解析与查表必须落在共享真源的已知值上。
    // rough=1 → u=15.5,列 15(clamp 后 i0=i1=15)→ 行 15/列 15 表尾原值;
    // nv=1 → v=15.5,行 15 原值。
    assert_eq!(
        direct_dfg_185(1.0, 1.0),
        [0.34521484375, 0.00007051229476928711]
    );
    // 粗糙金属的高损失区:dfg185(0.9, 1) 手算参考(mjs 对拍同一数值)。
    let rough = 0.9 * 224.0 / 255.0;
    let dfg = direct_dfg_185(rough, 1.0);
    assert!((dfg[0] - 0.5701677390).abs() < 1e-8 && (dfg[1] - 0.0001047166).abs() < 1e-8);
    // 能量核区分度:rough=0.34(nv=nl=1)落在 185 表的低损失行(dfg.x≈0.984、
    // dfg.y≈3e-5),多散射远小于切换前冻结常量 (0.75,0.0625) 的口径;GPU 腿若
    // 回归旧资源,差分偏差 ≈ |Δenergy|·nl·radiance,必须远超 0.002 门。
    let f0 = 0.04 * (1.0 - METALLIC) + BASE_COLOR[0] * METALLIC;
    let energy_185 = multiscattering_energy(f0, ROUGHNESS, 1.0, 1.0);
    let legacy_view = [0.75, 0.0625];
    let single_legacy = f0 * legacy_view[0] + legacy_view[1];
    let lost_legacy = 1.0 - (legacy_view[0] + legacy_view[1]);
    let average = f0 + (1.0 - f0) * 0.047619;
    let energy_legacy = single_legacy * single_legacy * average
        / (1.0 - lost_legacy * lost_legacy * average + 0.000001)
        * lost_legacy
        * lost_legacy;
    assert!(
        energy_185 < energy_legacy,
        "r185 twin energy {energy_185} must sit below the frozen-constant legacy energy {energy_legacy} at rough 0.34"
    );
    assert!(
        (energy_legacy - energy_185) * 0.55_f64.sqrt() * RADIANCE[0] > 0.002,
        "regression to the frozen brdf_lut constant must break the 0.002 GPU budget"
    );
}
