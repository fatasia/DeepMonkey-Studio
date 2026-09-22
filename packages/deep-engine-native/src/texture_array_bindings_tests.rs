//! `texture_array_bindings` 的合同单测(纯逻辑,无需 GPU)+ 真机描述符验证
//! (沿 gpu_textures.rs 的 `#[ignore = "requires a real GPU adapter"]` 先例)。

use super::*;
use deep_engine_native::texture_array_packing::{
    TextureArrayAssignment, TextureArrayPackingEntry, TextureArrayPlan, TextureArrayPlanEntry,
    plan_texture_arrays,
};

fn entry(id: &str, format: &str, width: u32, height: u32) -> TextureArrayPackingEntry {
    TextureArrayPackingEntry {
        texture_id: id.into(),
        format: format.into(),
        width,
        height,
    }
}

fn rgba8(id: &str) -> TextureArrayPackingEntry {
    entry(id, "rgba8unorm", 512, 512)
}

#[test]
fn slot_index_channel_layout_matches_web_contract() {
    assert_eq!(ARRAY_INDICES_BINDING, 13);
    assert_ne!(ARRAY_INDICES_BINDING, 11);
    assert_ne!(ARRAY_INDICES_BINDING, 12);
    let indices = MaterialArrayIndices::from_slot_layers([Some(3), None, Some(1), None, Some(2)]);
    // offsets 0..4 = baseColor/metallicRoughness/occlusion/normal/emissive;未分配写 0。
    assert_eq!(indices.0, [3, 0, 1, 0, 2, 0, 0, 0]);
    assert_eq!(
        indices.as_bytes().len() as u64,
        MATERIAL_ARRAY_INDICES_BYTES
    );
    assert_eq!(MATERIAL_ARRAY_INDICES_BYTES, 32);
    let empty = MaterialArrayIndices::from_slot_layers([None; MATERIAL_ARRAY_SLOT_COUNT]);
    assert_eq!(empty.0, [0; MATERIAL_ARRAY_INDEX_FLOATS]);
}

#[test]
fn validate_plan_accepts_packed_plan_and_rejects_degenerate_limit() {
    let plan = plan_texture_arrays(&[rgba8("a"), rgba8("b"), rgba8("c")], 2).expect("packs");
    assert_eq!(validate_plan_against_device(&plan, 2), Ok(()));
    // 设备上限为 0 视为上限不可用,合同 fail-closed。
    assert!(validate_plan_against_device(&plan, 0).is_err());
}

#[test]
fn validate_plan_rejects_index_divergence() {
    // 两个尺寸档 → 两个数组,才有 index 1 可供破坏。
    let mut plan =
        plan_texture_arrays(&[rgba8("a"), entry("b", "rgba16float", 256, 256)], 4).expect("packs");
    plan.arrays[1].array_index = 7;
    let error = validate_plan_against_device(&plan, 4).unwrap_err();
    assert!(error.contains("diverged from position"), "{error}");
}

#[test]
fn validate_plan_rejects_device_layer_overflow() {
    let plan = plan_texture_arrays(&[rgba8("a"), rgba8("b"), rgba8("c")], 3).expect("packs");
    // 计划按 max=3 打满;拿 max=2 的设备验收必须拒绝,而不是静默钳制。
    let error = validate_plan_against_device(&plan, 2).unwrap_err();
    assert!(
        error.contains("exceeds device maxTextureArrayLayers"),
        "{error}"
    );
}

#[test]
fn validate_plan_rejects_out_of_bounds_assignment() {
    // 两个尺寸档 → 两个数组;移除第二个数组后 b 的分配指向不存在的数组。
    let mut plan =
        plan_texture_arrays(&[rgba8("a"), entry("b", "rgba16float", 256, 256)], 4).expect("packs");
    plan.arrays.remove(1);
    let error = validate_plan_against_device(&plan, 4).unwrap_err();
    assert!(error.contains("out of bounds"), "{error}");
}

#[test]
fn validate_plan_rejects_overflowed_texture_keeping_assignment() {
    // 直接构造「分配在界内但纹理已溢出」的最小计划:越界检查先过,
    // 才能命中溢出残留分配这一条(逐条规则的独立覆盖)。
    let mut plan = TextureArrayPlan::default();
    plan.arrays.push(TextureArrayPlanEntry {
        format: "rgba8unorm".into(),
        width: 512,
        height: 512,
        array_index: 0,
        layers: vec!["b".into()],
    });
    plan.overflowed.push("b".into());
    plan.assignments.insert(
        "b".into(),
        TextureArrayAssignment {
            array_index: 0,
            layer_index: 0,
        },
    );
    let error = validate_plan_against_device(&plan, 4).unwrap_err();
    assert!(
        error.contains("must not keep an array assignment"),
        "{error}"
    );
}

#[test]
fn format_parser_admits_uncompressed_and_rejects_rest() {
    assert_eq!(
        parse_texture_format_name("rgba8unorm"),
        Some(wgpu::TextureFormat::Rgba8Unorm)
    );
    assert_eq!(
        parse_texture_format_name("rgba16float"),
        Some(wgpu::TextureFormat::Rgba16Float)
    );
    assert_eq!(
        parse_texture_format_name("bgra8unorm-srgb"),
        Some(wgpu::TextureFormat::Bgra8UnormSrgb)
    );
    // 压缩格式不入数组(级 1/2 合同):返回 None 由调用方 fail-closed 拒绝。
    assert_eq!(parse_texture_format_name("bc1-rgba-unorm"), None);
    assert_eq!(parse_texture_format_name("definitely-not-a-format"), None);
}

/// 真机描述符验证:layout 描述符、数组纹理、D2Array 视图与索引 buffer 均可创建。
#[test]
#[ignore = "requires a real GPU adapter"]
fn array_descriptors_validate_on_real_device() {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("real GPU adapter");
        let (device, _queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        // 创建即验证:layout 描述符在设备端校验通过(非法描述符此处即失败)。
        let _layout = create_texture_array_material_layout(&device);
        let plan = plan_texture_arrays(&[rgba8("a"), rgba8("b"), rgba8("c")], 2).expect("packs");
        validate_plan_against_device(&plan, 2).expect("plan consistent");
        let array = &plan.arrays[0];
        let texture = create_array_texture(
            &device,
            array,
            1,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        )
        .expect("array texture");
        assert_eq!(
            texture.size().depth_or_array_layers,
            array.layers.len() as u32
        );
        let _view = create_texture_array_view(&texture);
        let indices = MaterialArrayIndices::from_slot_layers([Some(0), None, None, None, Some(1)]);
        let buffer = create_material_array_indices_buffer(&device, &indices);
        assert_eq!(buffer.size(), MATERIAL_ARRAY_INDICES_BYTES);
    });
}
