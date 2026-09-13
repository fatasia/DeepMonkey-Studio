use super::*;
use crate::shader_package::{ShaderAbiBinding, parse_and_validate_shader_package};

fn abi_bindings(file: &[u8], id: &str) -> Vec<wgpu::BindGroupLayoutEntry> {
    let package = parse_and_validate_shader_package(file).expect("validated fixture");
    let layout = package
        .shader_abi
        .contract
        .bind_group_layouts
        .into_iter()
        .find(|layout| layout.id == id)
        .expect("frame layout");
    bind_group_entries(&layout).expect("valid descriptor")
}

#[test]
fn csm_array_and_uniform_descriptors_preserve_non_dynamic_shadow_frames() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/deep_shader_package_csm_v2.json"
    ))
    .expect("CSM fixture");
    let forward = abi_bindings(&bytes, "forward-frame");
    assert_eq!(forward.len(), 8);
    assert_eq!(forward[1].visibility, wgpu::ShaderStages::FRAGMENT);
    assert_eq!(
        forward[1].ty,
        wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Depth,
            view_dimension: wgpu::TextureViewDimension::D2Array,
            multisampled: false,
        }
    );
    assert_eq!(forward[7].binding, 7);
    assert_eq!(forward[7].visibility, wgpu::ShaderStages::FRAGMENT);
    assert_eq!(
        forward[7].ty,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: NonZeroU64::new(336),
        }
    );
    let shadow = abi_bindings(&bytes, "shadow-frame");
    assert_eq!(shadow.len(), 1);
    assert_eq!(
        shadow[0].ty,
        wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: NonZeroU64::new(208),
        }
    );
}

#[test]
fn frozen_v1_keeps_single_depth_texture_and_rejects_unknown_dimensions() {
    let bytes = include_bytes!("../../tests/fixtures/deep_shader_package_gpu_v2.json");
    let bindings = abi_bindings(bytes, "forward-frame");
    assert_eq!(bindings.len(), 7);
    assert!(matches!(
        bindings[1].ty,
        wgpu::BindingType::Texture {
            view_dimension: wgpu::TextureViewDimension::D2,
            ..
        }
    ));
    let binding = ShaderAbiBinding {
        name: "unsupported".into(),
        binding: 1,
        visibility: vec!["fragment".into()],
        resource: ShaderAbiBindingResource::Texture {
            sample_type: "depth".into(),
            view_dimension: "3d".into(),
            multisampled: false,
        },
    };
    assert!(
        binding_entry(&binding)
            .expect_err("unknown dimension")
            .contains("view dimension")
    );
}
