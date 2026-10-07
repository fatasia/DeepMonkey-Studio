//! sdf-gi 生产帧接线的 CPU 测试:包解包/天空辐射/构建合同/记录流 storage
//! 合同/窗口确定性/门控解析/fail-closed 反例。全程无 GPU 依赖(上传半分离)。

use super::*;
use deep_engine_native::contract::{GeometryResource, RenderInstance, RenderPacket};
use deep_engine_native::probe_gi_grid::{
    ProbeGiGridHeader, decode_probe_grid_cascade, pack_cascade_records,
};

/// 单位立方体(边长 2,中心原点):8 顶点 ×(position.xyz + normal.xyz),
/// 12 三角形。顶点步长 6 与生产包一致。
fn cube_geometry(id: &str) -> GeometryResource {
    let corners: [[f32; 3]; 8] = [
        [-1.0, -1.0, -1.0],
        [1.0, -1.0, -1.0],
        [1.0, 1.0, -1.0],
        [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0],
        [1.0, -1.0, 1.0],
        [1.0, 1.0, 1.0],
        [-1.0, 1.0, 1.0],
    ];
    let mut vertices = Vec::with_capacity(8 * 6);
    for corner in &corners {
        vertices.extend_from_slice(corner);
        vertices.extend_from_slice(&[0.0, 1.0, 0.0]);
    }
    let indices: Vec<u32> = vec![
        0, 2, 1, 0, 3, 2, // -Z
        4, 5, 6, 4, 6, 7, // +Z
        4, 7, 3, 4, 3, 0, // -X
        1, 2, 6, 1, 6, 5, // +X
        3, 7, 6, 3, 6, 2, // +Y
        4, 0, 1, 4, 1, 5, // -Y
    ];
    GeometryResource {
        id: id.into(),
        revision: 1,
        vertices,
        uv0: None,
        uv1: None,
        tangents: None,
        colors: None,
        indices,
    }
}

fn packet_with(instances: Vec<RenderInstance>, geometries: Vec<GeometryResource>) -> RenderPacket {
    RenderPacket {
        schema: "deep.render.v1".into(),
        version: 1,
        geometries,
        materials: Vec::new(),
        instances,
        textures: Vec::new(),
    }
}

fn instance(id: &str, geometry: &str, transform: [f32; 16]) -> RenderInstance {
    RenderInstance {
        id: id.into(),
        geometry: geometry.into(),
        material: "m0".into(),
        transform,
        cast_shadow: None,
        receive_shadow: None,
        outline: None,
        lod: None,
    }
}

fn identity() -> [f32; 16] {
    let mut m = [0.0f32; 16];
    m[0] = 1.0;
    m[5] = 1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    m
}

fn build_runtime(
    packet: &RenderPacket,
    diffuse: &[[f32; 4]],
) -> Result<SdfGiFrameRuntime, SdfGiReject> {
    let (sources, skipped) = bake_sources_from_packet(packet);
    SdfGiFrameRuntime::build(&sources, skipped, diffuse)
}

#[test]
fn bake_sources_deinterleave_and_transform_mapping() {
    let packet = packet_with(
        vec![
            instance("a", "cube", {
                let mut m = identity();
                m[5] = 2.0; // 列主:y 基列缩放
                m[14] = 7.0; // 平移 z
                m
            }),
            instance("b", "cube", identity()),
            instance("ghost", "missing", identity()),
        ],
        vec![cube_geometry("cube")],
    );
    let (sources, skipped) = bake_sources_from_packet(&packet);
    assert_eq!(skipped, 1, "几何缺席实例必须跳过并计数");
    assert_eq!(sources.len(), 2);
    // 共享几何:Arc 同源(百实例引用一几何不复制百份)。
    assert!(std::sync::Arc::ptr_eq(
        &sources[0].positions,
        &sources[1].positions
    ));
    // 顶点解包:步长 6 → xyz 三元组(顶点 1 = [1,-1,-1])。
    assert_eq!(&sources[0].positions[3..6], &[1.0, -1.0, -1.0]);
    // 列主 4×4 → 行主 basis + 平移:basis[4](row1,col1)= m[5];translation[2]= m[14]。
    assert_eq!(sources[0].transform.basis[4], 2.0);
    assert_eq!(sources[0].transform.translation, [0.0, 0.0, 7.0]);
    assert_eq!(
        sources[1].transform.basis,
        [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    );
}

#[test]
fn sky_radiance_is_finite_texel_mean() {
    assert_eq!(
        sky_radiance_from_environment(&[[1.0, 2.0, 3.0, 9.0], [3.0, 2.0, 1.0, 1.0]]),
        Some([2.0, 2.0, 2.0])
    );
    // 非有限纹素跳过;全无效 = None(fail-closed)。
    assert_eq!(
        sky_radiance_from_environment(&[[1.0, 1.0, 1.0, 1.0], [f32::NAN, 0.0, 0.0, 0.0]]),
        Some([1.0, 1.0, 1.0])
    );
    assert_eq!(sky_radiance_from_environment(&[]), None);
    assert_eq!(sky_radiance_from_environment(&[[f32::NAN; 4]; 2]), None);
}

#[test]
fn build_produces_grid_contract_records() {
    let packet = packet_with(
        vec![instance("box", "cube", identity())],
        vec![cube_geometry("cube")],
    );
    let diffuse = vec![[1.0, 2.0, 0.5, 1.0]; 6];
    let runtime = build_runtime(&packet, &diffuse).expect("cube scene must bake");
    let (probe_count, dispatched, skipped) = runtime.telemetry();
    assert_eq!(dispatched, 0);
    assert_eq!(skipped, 0);
    assert!(probe_count > 0 && probe_count <= SDF_GI_MAX_PROBES);
    assert_eq!(
        probe_count,
        runtime.lattice().dimensions.iter().product::<usize>()
    );
    assert_eq!(runtime.directions().len(), SDF_GI_DIRECTION_COUNT as usize);

    let records = runtime
        .initial_records()
        .expect("records obey grid contract");
    assert_eq!(records.len(), 1 + probe_count);
    // legacy 单层格头可解码,格尺寸 = lattice 尺寸,探针数一致。
    let header = ProbeGiGridHeader::decode(&records[0]).expect("legacy grid header");
    assert_eq!(
        header.grid_size,
        [
            runtime.lattice().dimensions[0] as u32,
            runtime.lattice().dimensions[1] as u32,
            runtime.lattice().dimensions[2] as u32
        ]
    );
    assert_eq!(header.probe_count as usize, probe_count);
    // 级联解码与 storage 打包(逐记录 validate)全绿 = 记录流达到物化合同。
    let cascade = decode_probe_grid_cascade(&records).expect("cascade decode");
    assert!(cascade.layout.is_none(), "sdf-gi 记录流 = legacy 单层格");
    assert!(pack_cascade_records(&records).is_ok());
}

#[test]
fn window_compute_is_deterministic_and_contract_safe() {
    let packet = packet_with(
        vec![instance("box", "cube", identity())],
        vec![cube_geometry("cube")],
    );
    let diffuse = vec![[1.0, 2.0, 0.5, 1.0]; 6];
    let mut runtime = build_runtime(&packet, &diffuse).expect("bake");
    let mut twin = build_runtime(&packet, &diffuse).expect("bake twin");
    let (offset_a, records_a) = runtime.compute_window().expect("budget > 0");
    let (offset_b, records_b) = twin.compute_window().expect("budget > 0");
    assert_eq!(offset_a, 0, "首窗口从探针 0 起");
    assert_eq!(offset_b, 0);
    assert_eq!(records_a, records_b, "同输入逐位同输出(无 RNG)");
    assert!(records_a.len() <= SDF_GI_PROBE_WINDOW_BUDGET as usize);
    for record in &records_a {
        record.validate().expect("window records obey 96B ABI");
        // 目标场 = mean(vis·sky) ≤ 天空辐射(钳制上界);occlusionFloor = c0 ∈ [0,1]。
        assert!(record.irradiance[0] <= 1.0 + 1e-5 && record.irradiance[1] <= 2.0 + 1e-5);
        assert!((0.0..=1.0).contains(&record.occlusion_floor));
        assert_eq!(record.validity, 1.0);
    }
    let (_, dispatched, _) = runtime.telemetry();
    assert_eq!(dispatched, 1);
    // 预算清零路径:计划预算 0 → (0,0)(不派发窗口)。
    assert_eq!(
        deep_engine_native::sdf_gi_probe_update::plan_sdf_gi_probe_window(
            runtime.telemetry().0,
            0.0,
            0
        ),
        (0, 0)
    );
}

#[test]
fn flat_scene_and_missing_sky_fail_closed() {
    // 扁平场景:xz 平面四边形(y 向零延展)→ lattice 单轴 dim 1 → 格合同拒。
    let mut quad = cube_geometry("quad");
    quad.vertices = vec![
        -1.0, 0.0, -1.0, 0.0, 1.0, 0.0, //
        1.0, 0.0, -1.0, 0.0, 1.0, 0.0, //
        1.0, 0.0, 1.0, 0.0, 1.0, 0.0, //
        -1.0, 0.0, 1.0, 0.0, 1.0, 0.0, //
    ];
    quad.indices = vec![0, 1, 2, 0, 2, 3];
    let packet = packet_with(vec![instance("flat", "quad", identity())], vec![quad]);
    // 零延展轴按 lattice 公式 floor(0).max(1)+1 = 2(与 TS deriveSdfGiProbeLattice
    // 同式):扁场合法构建,y 轴恒 2 层探针,格合同(单轴 ≥2)天然满足。
    let flat = build_runtime(&packet, &[[1.0, 1.0, 1.0, 1.0]; 6]).expect("flat scene bakes");
    assert_eq!(flat.lattice().dimensions[1], 2);
    // 场景级 cells 超预算(100×100×30m,cell 钳 1.0 → 101×101×31 > 262 144)
    // = 整场烘焙拒绝(fail-closed 回退,TS 同一口径的规模墙)。
    let mut big = cube_geometry("big");
    for vertex in big.vertices.chunks_mut(6) {
        vertex[0] *= 50.0;
        vertex[1] *= 50.0;
        vertex[2] *= 15.0;
    }
    let big_packet = packet_with(vec![instance("big", "big", identity())], vec![big]);
    assert!(matches!(
        build_runtime(&big_packet, &[[1.0; 4]; 6]),
        Err(SdfGiReject::BakeContract)
    ));
    // 天空辐射缺席 = 拒(在烘焙之前)。
    let cube_packet = packet_with(
        vec![instance("box", "cube", identity())],
        vec![cube_geometry("cube")],
    );
    assert!(matches!(
        build_runtime(&cube_packet, &[]),
        Err(SdfGiReject::SkyRadianceMissing)
    ));
    // 无实例 = 拒(NoBakeableInstances)。
    assert!(matches!(
        build_runtime(&packet_with(Vec::new(), Vec::new()), &[[1.0; 4]; 6]),
        Err(SdfGiReject::NoBakeableInstances)
    ));
}

#[test]
fn gate_parse_defaults_closed() {
    assert!(!parse_sdf_gi_mode(None));
    assert!(!parse_sdf_gi_mode(Some("0")));
    assert!(!parse_sdf_gi_mode(Some("off")));
    assert!(!parse_sdf_gi_mode(Some("AUTO")));
    assert!(!parse_sdf_gi_mode(Some("")));
    assert!(parse_sdf_gi_mode(Some("1")));
    assert!(parse_sdf_gi_mode(Some("on")));
    assert!(parse_sdf_gi_mode(Some("TRUE")));
    assert!(parse_sdf_gi_mode(Some(" enabled ")));
}
