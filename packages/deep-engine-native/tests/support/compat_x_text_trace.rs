use super::*;
use deep_engine_native::platform_text::{
    ImeSession, TextDocumentV1, TextRasterRequest, TextRasterizer,
};

fn committed_snapshots() -> Vec<(u64, String)> {
    let bytes = include_bytes!("../../../deep-engine/fixtures/deep2d-rich-text-ime-trace-v1.json");
    assert_eq!(
        deep_engine_native::adapter_n1::fixture_digest(bytes).unwrap(),
        "c5c5ac85f2fb3c411aa75bf09baadd0f84beea9b6fb02b674b5563c0e4171b3d"
    );
    let trace: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let document = TextDocumentV1::new(
        trace["initial"]["text"].as_str().unwrap(),
        vec![],
        vec![],
        vec![],
    )
    .unwrap();
    let mut session = ImeSession::new(document, 8);
    session
        .set_caret(trace["initial"]["caretCluster"].as_u64().unwrap() as usize)
        .unwrap();
    let mut snapshots = vec![];
    for event in trace["events"].as_array().unwrap() {
        let old = session.document().clone();
        let op = event["op"].as_str().unwrap();
        let result = match op {
            "focus" => {
                session.focus();
                Ok(())
            }
            "blur" => {
                session.blur();
                Ok(())
            }
            "set-caret" => session.set_caret(event["cluster"].as_u64().unwrap() as usize),
            "begin" => session.begin_composition(),
            "preedit" => session.update_preedit(event["text"].as_str().unwrap()),
            "commit" => session.commit().map(|_| ()),
            "cancel" => session.cancel_composition(),
            _ => panic!("unsupported fixture operation"),
        };
        assert_eq!(result.is_err(), event.get("expectedError").is_some());
        assert_eq!(
            session.document().text(),
            event["expected"]["documentText"].as_str().unwrap()
        );
        assert_eq!(
            session.revision(),
            event["expected"]["revision"].as_u64().unwrap()
        );
        if event["publishN1"].as_bool() == Some(true) {
            assert_eq!(op, "commit");
            snapshots.push((session.revision(), session.document().text().to_owned()));
        } else {
            assert_eq!(&old, session.document());
        }
    }
    assert_eq!(
        serde_json::to_value(snapshots.iter().map(|(_, text)| text).collect::<Vec<_>>()).unwrap(),
        trace["expectedN1Snapshots"]
    );
    snapshots
}

#[test]
#[ignore = "requires Windows fonts, real GPU and static CRT X worker"]
fn committed_ime_text_keeps_pixels_through_lpac_and_rejected_epochs() {
    let snapshots = committed_snapshots();
    let worker = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/x_compat_worker.exe");
    let config = XProcessConfig {
        enabled: true,
        ..Default::default()
    };
    let mut session = Session::start(&worker, config).unwrap();
    let host = XCompatibilityHost::new(true, config.budget).unwrap();
    let mut rasterizer = TextRasterizer::new();
    assert!(rasterizer.family_exists("Microsoft YaHei"));
    pollster::block_on(async {
        let (device, queue, adapter) = readback::gpu_device().await;
        let cache = Arc::new(deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let mut previous = None;
        for (revision, text) in &snapshots {
            let raster = rasterizer
                .rasterize(TextRasterRequest {
                    text,
                    family: "Microsoft YaHei",
                    font_size: 24.0,
                    line_height: 32.0,
                    width: 300,
                    height: 80,
                    color: [40, 160, 220, 230],
                })
                .unwrap();
            assert!(raster.glyph_count > 0);
            assert!(
                raster
                    .rgba
                    .chunks_exact(4)
                    .filter(|pixel| pixel[3] > 0)
                    .count()
                    > 50
            );
            let display = raster
                .into_display_list(
                    "ime.committed",
                    *revision,
                    [WIDTH as f64, HEIGHT as f64],
                    [10.0, 10.0],
                    0,
                )
                .unwrap();
            let request = XRequest {
                schema_version: 1,
                expected_epoch: *revision,
                started_at_ms: 100,
                random_seed: 7,
                resources: vec![],
                events: vec![],
                calls: vec![XCall::EmitDisplayList(Box::new(display.clone()))],
            };
            let context = XExecutionContext {
                current_epoch: *revision,
                now_ms: 100,
                cancelled: false,
            };
            let candidate = session.evaluate(&request, || context).unwrap();
            let messages = host
                .publish(CompatibilityLane::ExperimentalX, candidate, context)
                .unwrap();
            let [XMessage::DisplayList(returned)] = messages.as_slice() else {
                panic!("display receipt missing");
            };
            assert_eq!(
                returned.as_ref(),
                &display,
                "unicode-derived atlas bytes changed in IPC"
            );
            let direct = deep2d_gpu::Deep2dGpuPainter::new(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &Deep2dRuntimeContent::DisplayList(display),
                &cache,
            )
            .unwrap();
            let runtime = Deep2dRuntimeContent::DisplayList(returned.as_ref().clone());
            let painter = if let Some(active) = &previous {
                deep2d_gpu::Deep2dGpuPainter::stage_update(
                    active,
                    &device,
                    &queue,
                    wgpu::TextureFormat::Rgba8Unorm,
                    &runtime,
                )
                .unwrap()
            } else {
                deep2d_gpu::Deep2dGpuPainter::new(
                    &device,
                    &queue,
                    wgpu::TextureFormat::Rgba8Unorm,
                    &runtime,
                    &cache,
                )
                .unwrap()
            };
            let expected = readback::draw_and_read(&direct, &device, &queue, "N0 committed text");
            let actual = readback::draw_and_read(&painter, &device, &queue, "X committed text");
            assert_eq!(actual, expected);
            assert!(actual.iter().filter(|pixel| **pixel != BG).count() > 50);
            let stale = session.evaluate(&request, || context).unwrap();
            assert!(
                host.publish(
                    CompatibilityLane::ExperimentalX,
                    stale,
                    XExecutionContext {
                        current_epoch: revision + 1,
                        ..context
                    }
                )
                .is_err()
            );
            assert_eq!(
                readback::draw_and_read(&painter, &device, &queue, "stale text rejected"),
                actual
            );
            previous = Some(painter);
            println!(
                "IME X GPU adapter={adapter} revision={revision} text={text:?} pixels={} mismatch=0 stale=retained",
                actual.len()
            );
        }
    });
    session.close().unwrap();
    assert_eq!(snapshots.len(), 3);
}
