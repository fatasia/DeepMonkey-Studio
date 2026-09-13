use std::{path::PathBuf, sync::Arc};

use deep_engine_native::shader_package::ShaderPackageGpuExecutor;

use crate::{
    shader_package_probe_draw::draw_and_readback, shader_package_probe_resources::ProbeResources,
};

pub fn run() -> Result<(), String> {
    pollster::block_on(run_async())
}

async fn run_async() -> Result<(), String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .map_err(|error| format!("Vulkan adapter request failed: {error}"))?;
    let info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("Deep Shader Package GPU probe"),
            ..Default::default()
        })
        .await
        .map_err(|error| format!("GPU device request failed: {error}"))?;

    let bytes = std::fs::read(fixture("deep_shader_package_gpu_v2.json"))
        .map_err(|error| format!("cannot read GPU package fixture: {error}"))?;
    let invalid = std::fs::read(fixture("deep_shader_package_invalid_wgsl_v2.json"))
        .map_err(|error| format!("cannot read invalid GPU package fixture: {error}"))?;
    let mut executor = ShaderPackageGpuExecutor::default();
    let executable = executor
        .prepare_bytes(&device, &bytes)
        .map_err(|error| error.to_string())?;
    let cached = executor
        .prepare_bytes(&device, &bytes)
        .map_err(|error| error.to_string())?;
    if !Arc::ptr_eq(&executable, &cached) || executor.cache_size() != 1 {
        return Err("valid package did not return the atomic cache entry".into());
    }
    let invalid_error = executor
        .prepare_bytes(&device, &invalid)
        .expect_err("invalid WGSL must fail GPU creation");
    if executor.cache_size() != 1 || !invalid_error.to_string().contains("missingSymbol") {
        return Err(format!(
            "failed candidate changed the cache or lost WGSL evidence: {invalid_error}"
        ));
    }

    let forward = executable
        .pass("pbr/forward")
        .ok_or("forward pass missing")?;
    let shadow = executable.pass("pbr/shadow").ok_or("shadow pass missing")?;
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let probe_result = (|| {
        let resources = ProbeResources::new(&device, &queue, forward, shadow)?;
        draw_and_readback(&device, &queue, forward, shadow, &resources)
    })();
    let poll_error = device
        .poll(wgpu::PollType::wait_indefinitely())
        .err()
        .map(|error| error.to_string());
    let gpu_errors = [
        internal_scope.pop().await,
        memory_scope.pop().await,
        validation_scope.pop().await,
    ];
    if let Some(error) = poll_error.or_else(|| {
        gpu_errors
            .into_iter()
            .flatten()
            .next()
            .map(|error| error.to_string())
    }) {
        return Err(format!(
            "shader package resource/draw probe rejected: {error}"
        ));
    }
    let (forward_pixel, shadow_depth) = probe_result?;
    if forward_pixel != [0.25, 0.5, 0.75, 1.0] {
        return Err(format!("unexpected resolved HDR pixel {forward_pixel:?}"));
    }
    if (shadow_depth - 0.25).abs() > 0.000_001 {
        return Err(format!("unexpected shadow depth {shadow_depth}"));
    }
    let epoch = executor.device_epoch();
    executor.invalidate_device();
    if executor.cache_size() != 0 || executor.device_epoch() == epoch {
        return Err("device invalidation did not clear package objects".into());
    }
    println!(
        "Native shader package GPU executor OK: backend={:?} adapter={:?} passes={} forward_rgba={forward_pixel:?} shadow_depth={shadow_depth:.6} resolve=required bindings=probe-owned-abi-resources scene_binding=renderer-owned cache_hit=true failed_candidate_preserved=true device_epoch={}",
        info.backend,
        info.name,
        executable.passes.len(),
        executor.device_epoch(),
    );
    Ok(())
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/{name}"))
}
