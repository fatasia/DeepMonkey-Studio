use std::sync::Arc;

use deep_engine_native::shader_package::{ShaderPackageExecutionError, ShaderPackageGpuExecutor};

const V1: &[u8] = include_bytes!("fixtures/deep_shader_package_gpu_v2.json");
const INVALID: &[u8] = include_bytes!("fixtures/deep_shader_package_invalid_wgsl_v2.json");

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn csm_and_v1_pipelines_coexist_and_failed_compilation_preserves_the_cache() {
    let v2 = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/deep_shader_package_csm_v2.json"
    ))
    .expect("CSM fixture");
    let (adapter, device) = pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let (device, _) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("GPU device");
        (adapter, device)
    });
    println!("Shader ABI v2 real adapter: {:?}", adapter.get_info());
    let mut executor = ShaderPackageGpuExecutor::default();
    let old = executor.prepare_bytes(&device, V1).expect("v1 pipelines");
    let csm = executor.prepare_bytes(&device, &v2).expect("CSM pipelines");
    assert_ne!(old.package_cache_key, csm.package_cache_key);
    assert_eq!(executor.cache_size(), 2);
    assert_eq!(csm.device_epoch, 0);
    for pass in &csm.passes {
        assert_eq!(
            pass.bind_group_layouts.len(),
            pass.bind_group_contracts.len()
        );
        assert_eq!(
            pass.bind_group_contracts[0].bindings.len(),
            if pass.kind == "forward" { 8 } else { 1 }
        );
    }
    let cached = executor.prepare_bytes(&device, &v2).expect("cached v2");
    assert!(Arc::ptr_eq(&cached, &csm));
    assert!(matches!(
        executor.prepare_bytes(&device, INVALID),
        Err(ShaderPackageExecutionError::Gpu(_))
    ));
    assert_eq!(executor.cache_size(), 2);
    assert!(Arc::ptr_eq(
        &executor.prepare_bytes(&device, &v2).expect("preserved v2"),
        &csm
    ));

    executor.invalidate_device();
    assert_eq!(executor.cache_size(), 0);
    assert_eq!(executor.device_epoch(), 1);
    let rebuilt = executor.prepare_bytes(&device, &v2).expect("rebuilt v2");
    assert_eq!(rebuilt.device_epoch, 1);
    assert!(!Arc::ptr_eq(&rebuilt, &csm));
    assert_eq!(rebuilt.package_cache_key, csm.package_cache_key);
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn device_replacement_rebuilds_packages_deterministically_on_a_new_device() {
    let (adapter, first_device, replacement_device) = pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let (first_device, _) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("first GPU device");
        let (replacement_device, _) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .expect("replacement GPU device");
        (adapter, first_device, replacement_device)
    });
    println!(
        "Shader ABI v2 dual-device adapter: {:?}",
        adapter.get_info()
    );
    let mut executor = ShaderPackageGpuExecutor::default();
    let first = executor
        .prepare_bytes(&first_device, V1)
        .expect("package on the first device");
    assert_eq!(first.device_epoch, 0);

    executor.invalidate_device();
    assert_eq!(executor.cache_size(), 0);
    let rebuilt = executor
        .prepare_bytes(&replacement_device, V1)
        .expect("package rebuilt on the replacement device");
    assert_eq!(executor.device_epoch(), 1);
    assert_eq!(rebuilt.device_epoch, 1);
    assert!(
        !Arc::ptr_eq(&rebuilt, &first),
        "epoch invalidation must not resurrect the previous device's handles"
    );
    assert_eq!(
        rebuilt.package_cache_key, first.package_cache_key,
        "rebuild must stay content-deterministic across devices"
    );
    assert_eq!(rebuilt.passes.len(), first.passes.len());
    assert_eq!(executor.cache_size(), 1);
}
