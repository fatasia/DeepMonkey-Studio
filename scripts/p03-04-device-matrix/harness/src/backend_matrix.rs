//! Backend and viewport matrix with cross-backend and scaling comparisons.
use super::*;

pub(super) async fn run(
    args: &Args,
    runtime: &DashboardRuntime,
    page_logical: [f64; 2],
    clipped_nodes: &[(String, [f64; 4])],
) -> Result<(serde_json::Map<String, Value>, Vec<Value>, Value, Value), String> {
    let mut cells: Vec<Value> = Vec::new();
    let mut adapters = serde_json::Map::new();
    let mut snapshots: std::collections::BTreeMap<String, (Vec<u8>, (u32, u32))> =
        std::collections::BTreeMap::new();

    let sizes: [(&str, (u32, u32)); 3] = [
        ("960x540", (960, 540)),
        ("1200x800", (1200, 800)),
        ("1920x1080", (1920, 1080)),
    ];

    // ---------- 后端 × 尺寸 ----------
    for (label, backend) in [
        ("vulkan", wgpu::Backends::VULKAN),
        ("dx12", wgpu::Backends::DX12),
    ] {
        let ctx = make_ctx(backend, label).await;
        adapters.insert(label.to_string(), adapter_json(&ctx.adapter.get_info()));
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        for (size_name, physical) in sizes {
            let id = format!("producer-{label}-{size_name}");
            let started = Instant::now();
            let (pixels, validation_error) =
                draw_readback(&ctx, runtime.content(), &cache, physical).await;
            if let Some(error) = &validation_error {
                return Err(format!("{id}: GPU validation error: {error}"));
            }
            let draw_ms = started.elapsed().as_millis() as u64;
            write_raw(&args.out, &id, &pixels)?;
            let (colored, ink, checksum) = pixel_stats(&pixels);
            let region = letterbox_region(
                [0., 0., page_logical[0], page_logical[1]],
                page_logical,
                physical,
            );
            let aspect_matches = (f64::from(physical.0) / f64::from(physical.1)
                - page_logical[0] / page_logical[1])
                .abs()
                < 1e-6;
            let (bands, bar_total, violations) = if aspect_matches {
                (Vec::new(), 0usize, -1i64) // 无 bar 区
            } else {
                let (bands, bar_total) = bar_bands(physical, page_logical);
                let violations = i64::try_from(violations_in_bands(&pixels, physical, &bands))
                    .unwrap_or(i64::MAX);
                (bands, bar_total, violations)
            };
            let mut clipped_report = Vec::new();
            for (node_id, rect) in clipped_nodes {
                let clip_region = letterbox_region(*rect, page_logical, physical);
                let colored_clip = colored_in_region(&pixels, physical, clip_region);
                clipped_report.push(json!({
                    "id": node_id,
                    "region": clip_region,
                    "coloredPixels": colored_clip,
                    "landed": colored_clip > 0,
                }));
            }
            cells.push(json!({
                "id": id,
                "group": "backend+size",
                "backend": label,
                "physical": [physical.0, physical.1],
                "format": "rgba8unorm",
                "file": format!("raw/{id}.rgba"),
                "checksum": checksum,
                "coloredPixels": colored,
                "inkPixels": ink,
                "drawMs": draw_ms,
                "letterbox": {
                    "pageLogical": page_logical,
                    "contentRegion": region,
                    "aspectMatchesPage": aspect_matches,
                    "barBands": bands,
                    "barPixelsTotal": bar_total,
                    "barViolations": violations,
                },
                "clippedLayers": clipped_report,
                "validationClean": validation_error.is_none(),
            }));
            snapshots.insert(id, (pixels, physical));
        }
        drop(cache);
        drop(ctx);
    }

    // ---------- 后端间 diff（960×540 同内容跨后端） ----------
    let backend_diff = {
        let (a, size_a) = snapshots
            .get("producer-vulkan-960x540")
            .ok_or("missing vulkan snapshot")?;
        let (b, size_b) = snapshots
            .get("producer-dx12-960x540")
            .ok_or("missing dx12 snapshot")?;
        if size_a != size_b {
            return Err("backend snapshots differ in size".into());
        }
        let physical = *size_a;
        let report = diff_pixels(a, b, physical, &args.out, "diff-backend-vulkan-vs-dx12")?;
        json!({
            "a": "producer-vulkan-960x540",
            "b": "producer-dx12-960x540",
            "physical": [physical.0, physical.1],
            "diffPixels": report.diff_pixels,
            "totalPixels": u64::from(physical.0) * u64::from(physical.1),
            "maxChannelDelta": report.max_delta,
            "diffBbox": report.bbox,
            "thresholdHistogram": report.thresholds,
            "maskFile": "raw/diff-backend-vulkan-vs-dx12.rgba",
        })
    };

    // ---------- 尺寸一致性（colored 计数随内容区面积近似等比） ----------
    let colored_of = |id: &str| -> f64 {
        cells
            .iter()
            .find(|cell| cell["id"] == json!(id))
            .and_then(|cell| cell["coloredPixels"].as_u64())
            .unwrap_or(0) as f64
    };
    let base960 = colored_of("producer-vulkan-960x540");
    let size_consistency = json!({
        "backend": "vulkan",
        "scale1200x800": {
            "expectedAreaRatio": 1.5625,
            "observedColoredRatio": colored_of("producer-vulkan-1200x800") / base960,
        },
        "scale1920x1080": {
            "expectedAreaRatio": 4.0,
            "observedColoredRatio": colored_of("producer-vulkan-1920x1080") / base960,
        },
        "note": "colored 像素计数随 letterbox 内容区面积近似等比；抗锯齿与亚像素覆盖造成偏差属预期",
    });

    Ok((adapters, cells, backend_diff, size_consistency))
}
