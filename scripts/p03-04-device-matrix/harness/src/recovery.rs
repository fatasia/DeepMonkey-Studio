//! Destroy/rebuild probes own independent GPU devices and caches.
use super::*;

pub(super) async fn run_recovery(
    args: &Args,
    runtime: &DashboardRuntime,
) -> Result<serde_json::Map<String, Value>, String> {
    // ---------- 设备丢失恢复（独立 adapter/device：destroy → 重建 → 重绘） ----------
    let mut device_loss = serde_json::Map::new();
    for (label, backend) in [
        ("vulkan", wgpu::Backends::VULKAN),
        ("dx12", wgpu::Backends::DX12),
    ] {
        let instance = make_instance(backend);
        let adapter = request_adapter(&instance, label).await;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|error| format!("device loss {label}: initial device: {error}"))?;
        let probe = BackendCtx {
            adapter: adapter.clone(),
            device,
            queue,
        };
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let (before, _) = draw_readback(&probe, runtime.content(), &cache, CANVAS).await;
        let checksum_before = format!("fnv1a64:{:016x}", fnv1a64(&before));
        drop(cache);
        let destroy_started = Instant::now();
        probe.device.destroy();
        let destroy_us = destroy_started.elapsed().as_micros() as u64;
        drop(probe);
        let rebuild_started = Instant::now();
        let (device2, queue2) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|error| format!("device loss {label}: rebuild device: {error}"))?;
        let rebuild_ms = rebuild_started.elapsed().as_millis() as u64;
        let probe2 = BackendCtx {
            adapter,
            device: device2,
            queue: queue2,
        };
        let cache2 = Arc::new(Deep2dGpuAssetCache::new());
        let (after1, error1) = draw_readback(&probe2, runtime.content(), &cache2, CANVAS).await;
        if let Some(error) = error1 {
            return Err(format!(
                "device loss {label}: rebuild draw validation: {error}"
            ));
        }
        let (after2, _) = draw_readback(&probe2, runtime.content(), &cache2, CANVAS).await;
        let equal = before == after1;
        let stable = after1 == after2;
        let diff = if equal {
            json!({"diffPixels": 0})
        } else {
            let report = diff_pixels(
                &before,
                &after1,
                CANVAS,
                &args.out,
                &format!("diff-deviceloss-{label}"),
            )?;
            json!({
                "diffPixels": report.diff_pixels,
                "maxChannelDelta": report.max_delta,
                "maskFile": format!("raw/diff-deviceloss-{label}.rgba"),
            })
        };
        device_loss.insert(
            label.to_string(),
            json!({
                "injection": "device.destroy() on an isolated device (headless 唯一可靠注入)",
                "checksumBefore": checksum_before,
                "destroyUs": destroy_us,
                "rebuildMs": rebuild_ms,
                "redrawEqualsBefore": equal,
                "redrawStableAcrossRepeat": stable,
                "diff": diff,
            }),
        );
        drop(cache2);
        drop(probe2);
    }

    Ok(device_loss)
}
