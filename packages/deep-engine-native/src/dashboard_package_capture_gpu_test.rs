//! Optional producer-package capture, using the same GPU painter as composition regression.
use super::*;

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
            let pixels = draw(&device, &queue, runtime.content(), &cache);
            assert_eq!(pixels.len(), WIDTH as usize * HEIGHT as usize * 4);
            capture(&format!("producer-page-{index}"), &pixels);
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
