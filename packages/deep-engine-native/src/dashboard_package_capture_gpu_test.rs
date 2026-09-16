//! Optional producer-package capture, using the same GPU painter as composition regression.
use super::*;

#[test]
#[ignore = "requires a real GPU and sRGB render target"]
fn authored_css_shape_colors_survive_srgb_presentation() {
    let package = parse_and_validate_runtime_package(include_bytes!(
        "../../deep-engine/fixtures/dashboard-content-runtime-v1.json"
    ))
    .unwrap();
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let pixels = draw_in_format(
            &device,
            &queue,
            package.deep2d.as_ref().unwrap(),
            &Arc::new(Deep2dGpuAssetCache::new()),
            wgpu::TextureFormat::Rgba8UnormSrgb,
        );
        // These are the authored CSS bytes, independent of producer linearization.
        for (x, expected) in [
            (115usize, [54u8, 139, 214]),
            (265, [51, 187, 153]),
            (415, [229, 170, 68]),
        ] {
            let offset = (95 * WIDTH as usize + x) * 4;
            let actual = &pixels[offset..offset + 3];
            assert!(
                actual.iter().zip(expected).all(|(a, e)| a.abs_diff(e) <= 1),
                "CSS shape color at {x},95: expected {expected:?}, got {actual:?}"
            );
        }
        capture_in_format("author-css-colors", &pixels, "rgba8unorm-srgb");
        assert!(scope.pop().await.is_none());
    });
}

#[test]
#[ignore = "requires a real GPU; optional DEEP_DASHBOARD_PACKAGE_PATH selects a producer package"]
fn producer_package_renders_real_pixels() {
    let bytes = match std::env::var_os("DEEP_DASHBOARD_PACKAGE_PATH") {
        Some(path) => std::fs::read(path).expect("read producer package"),
        None => include_bytes!("../../deep-engine/fixtures/dashboard-composition-v1.json").to_vec(),
    };
    let package = parse_and_validate_runtime_package(&bytes).expect("validate producer package");
    let mut runtime = DashboardRuntime::new(package.dashboard.expect("dashboard entrypoint"))
        .expect("prepare producer dashboard");
    let pages: Vec<_> = runtime
        .document()
        .pages
        .iter()
        .map(|page| page.id.clone())
        .collect();
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        for (index, page) in pages.iter().enumerate() {
            runtime.switch_page(page).unwrap();
            let pixels = draw_in_format(
                &device,
                &queue,
                runtime.content(),
                &cache,
                wgpu::TextureFormat::Rgba8UnormSrgb,
            );
            assert_eq!(pixels.len(), WIDTH as usize * HEIGHT as usize * 4);
            capture_in_format(
                &format!("producer-page-{index}"),
                &pixels,
                "rgba8unorm-srgb",
            );
            println!(
                "producer page {index}: {} colored pixels",
                pixels
                    .chunks_exact(4)
                    .filter(|pixel| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
                    .count()
            );
        }
        assert!(
            scope.pop().await.is_none(),
            "producer package GPU validation error"
        );
    });
}
