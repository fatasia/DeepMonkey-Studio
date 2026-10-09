//! Physical-device and error-scope helpers shared by standalone GPU test modules.

pub(crate) fn push_scopes(device: &wgpu::Device) -> [wgpu::ErrorScopeGuard; 3] {
    [
        device.push_error_scope(wgpu::ErrorFilter::Validation),
        device.push_error_scope(wgpu::ErrorFilter::OutOfMemory),
        device.push_error_scope(wgpu::ErrorFilter::Internal),
    ]
}

pub(crate) async fn clean_scopes(scopes: [wgpu::ErrorScopeGuard; 3], label: &str) {
    let [validation, memory, internal] = scopes;
    for error in [
        internal.pop().await,
        memory.pop().await,
        validation.pop().await,
    ] {
        assert!(error.is_none(), "{label} GPU error: {error:?}");
    }
}

pub(crate) async fn high_performance_device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .expect("real GPU adapter");
    let info = adapter.get_info();
    assert_ne!(info.device_type, wgpu::DeviceType::Cpu, "software adapter");
    println!("native scene cache adapter: {info:?}");
    adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap()
}
