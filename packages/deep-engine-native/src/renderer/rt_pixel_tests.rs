//! F2 RT pixel 纯逻辑单测(不触 device):RT shader 拼接源契约、诊断原因
//! 静态字符串、opaque 分支的回退判定要素。真机管线创建/编译由
//! `rt_pixel_gpu_tests` 定向覆盖。

use crate::renderer::rt_residency::RtResidencyReject;

/// RT fragment 拼接模块必须满足的源级契约:ray-query 使能前置、TLAS 槽
/// 绑定 10 与 frame_bindings::FRAME_RT_TLAS_BINDING 同值、fragment 入口
/// 与 ray-query 调用齐备。这些是 WGSL 编译前的静态防线,防止绑定槽位与
/// layout 漂移。
#[test]
fn rt_fragment_shader_source_contract() {
    let source = format!(
        "enable wgpu_ray_query;\n{}\n{}\n{}\n",
        include_str!("../../assets/shaders/native_mesh_v1.wgsl"),
        include_str!("../../assets/shaders/native_cascaded_shadow_v1.wgsl"),
        include_str!("../../assets/shaders/native_mesh_rt_fragment_v1.wgsl"),
    );
    // 使能行必须是第一条语句(拼接契约与 create_native_mesh_rt_shader 一致)。
    assert!(source.starts_with("enable wgpu_ray_query;\n"));
    // binding 10 = 场景 TLAS;与 frame_bindings::FRAME_RT_TLAS_BINDING 对齐。
    assert_eq!(crate::frame_bindings::FRAME_RT_TLAS_BINDING, 10);
    assert!(source.contains("@binding(10) var scene_tlas: acceleration_structure;"));
    // RT fragment 入口与 Ray Query 消费存在;普通 fragment_main 未被破坏。
    assert!(source.contains("@fragment fn fragment_main_rt("));
    assert!(source.contains("rayQueryInitialize(&rq, scene_tlas"));
    assert!(source.contains("rayQueryGetCommittedIntersection(&rq)"));
    // 普通 mesh shader 的入口仍在同一模块(vertex 阶段与栅格逐位同源)。
    assert!(source.contains("@fragment fn fragment_main("));
    assert!(source.contains("@vertex fn vertex_main("));
}

/// RT 驻留拒绝原因保持机器可读且不与本切片新增原因冲突;pixel 管线拒绝
/// 是独立原因,不复用驻留语义。
#[test]
fn rt_reject_reasons_stay_machine_readable() {
    assert_eq!(
        RtResidencyReject::MissingFeature.reason(),
        "adapter_feature_unavailable"
    );
    assert_eq!(RtResidencyReject::EmptyScene.reason(), "tlas_no_resident_instances");
    assert_eq!(RtResidencyReject::BudgetExceeded.reason(), "tlas_budget_exceeded");
    assert_eq!(RtResidencyReject::GeometryInvalid.reason(), "tlas_geometry_rejected");
}

/// RT opaque 分支的就绪要素与回退语义(源级钉死):encode_opaque_pass_rt
/// 与 encode_opaque_pass 同时存在,回退入口未被移除。
#[test]
fn rt_opaque_branch_keeps_raster_fallback() {
    let mesh_pass = include_str!("../mesh_pass.rs");
    assert!(mesh_pass.contains("pub fn encode_opaque_pass_rt("));
    assert!(mesh_pass.contains("pub fn encode_opaque_pass("));
    let frame = include_str!("frame.rs");
    // RT 分支调用与栅格回退同在 opaque 段。
    assert!(frame.contains("encode_opaque_pass_rt("));
    assert!(frame.contains("None => encode_opaque_pass("));
}
