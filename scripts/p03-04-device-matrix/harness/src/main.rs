//! P3-04 Windows 设备/驱动能力矩阵 —— 单机可执行切片（headless GPU 读回）。
//!
//! 设计约束：
//! - 不改生产源码：通过绝对 `#[path]` 镜像 bin 侧 `deep2d_gpu` 模块闭包
//!   （deep2d_gpu / deep2d_gpu_cache / deep2d_atlas_gpu / deep2d_scissor 及其
//!   子模块 vertex_transfer / draw_evidence），生产 crate 仅以路径依赖引用 lib。
//! - 后端维度：同一 producer 包分别在 wgpu Vulkan 与 DX12 后端 960×540 读回，
//!   逐像素 diff（差异像素数/最大通道差/分布直方图/包围盒/掩膜图）。
//! - 尺寸/DPI 维度：960×540 / 1200×800 / 1920×1080 三档 letterbox 读回，
//!   校验 letterbox 偏移（bar 区必须纯清屏色）与被裁剪图层无丢失。
//! - 字体维度：系统字体（Microsoft YaHei / Segoe UI）vs 冻结 Noto CJK
//!   （test-output/dashboard-multicomponent-fonts-20260917 冻结件，SHA-256 校验），
//!   记录回退行为与缺字形 fail-closed（rasterize 返回 Err）。
//! - 设备丢失恢复：device.destroy() 主动销毁 → 同 adapter 重建 → 重绘比对
//!   （headless 唯一可靠注入；运行中驱动级丢失不可注入，如实声明）。
//! - 环境指纹：wgpu AdapterInfo（名称/厂商/驱动/后端/设备类型/PCI 总线）。

#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_gpu.rs"]
pub mod deep2d_gpu;
#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_gpu_cache.rs"]
pub mod deep2d_gpu_cache;
#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_atlas_gpu.rs"]
pub mod deep2d_atlas_gpu;
#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_scissor.rs"]
pub mod deep2d_scissor;

use deep2d_gpu::Deep2dGpuPainter;
use deep2d_gpu_cache::Deep2dGpuAssetCache;

use deep_engine_native::dashboard_runtime::DashboardRuntime;
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use deep_engine_native::platform_text::{
    FrozenFontInput, FrozenFontRef, RasterizedText, TextFontStyle, TextAlign, TextRasterizer,
    TextRasterRequest, TextVerticalAlign, TextWrap,
};
use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
use deep_engine_native::platform_text::StyledTextRequest;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const CANVAS: (u32, u32) = (960, 540);

struct Args {
    out: PathBuf,
    package: PathBuf,
    fonts: PathBuf,
}

fn parse_args() -> Args {
    let mut out = None;
    let mut package = None;
    let mut fonts = None;
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--out" => out = Some(PathBuf::from(iter.next().expect("--out value"))),
            "--package" => package = Some(PathBuf::from(iter.next().expect("--package value"))),
            "--fonts" => fonts = Some(PathBuf::from(iter.next().expect("--fonts value"))),
            other => panic!("unknown argument {other}"),
        }
    }
    Args {
        out: out.expect("--out required"),
        package: package.expect("--package required"),
        fonts: fonts.expect("--fonts required"),
    }
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 与 bin 侧 harness 相同的 letterbox 映射（shader 语义：min-axis 等比 + 居中）。
fn letterbox_region(rect: [f64; 4], page: [f64; 2], physical: (u32, u32)) -> (i64, i64, i64, i64) {
    let scale = (f64::from(physical.0) / page[0]).min(f64::from(physical.1) / page[1]);
    let ox = (f64::from(physical.0) - page[0] * scale) / 2.;
    let oy = (f64::from(physical.1) - page[1] * scale) / 2.;
    let x0 = (ox + rect[0] * scale).floor().max(0.) as i64;
    let y0 = (oy + rect[1] * scale).floor().max(0.) as i64;
    let x1 = (ox + (rect[0] + rect[2]) * scale)
        .ceil()
        .min(f64::from(physical.0)) as i64;
    let y1 = (oy + (rect[1] + rect[3]) * scale)
        .ceil()
        .min(f64::from(physical.1)) as i64;
    (x0, y0, x1, y1)
}

fn colored_in_region(pixels: &[u8], physical: (u32, u32), region: (i64, i64, i64, i64)) -> usize {
    let (x0, y0, x1, y1) = region;
    (y0..y1)
        .flat_map(|y| (x0..x1).map(move |x| ((y as u32 * physical.0 + x as u32) * 4) as usize))
        .filter(|i| pixels[*i] != 0 || pixels[*i + 1] != 0 || pixels[*i + 2] != 0)
        .count()
}

/// letterbox bar 区：按几何只取与内容区 [oy, oy+Hs) / [ox, ox+Ws) 无交集的
/// 整行/整列带（半覆盖边缘行不属于 bar），bar 内必须全是清屏色 [0,0,0,0]。
fn bar_bands(physical: (u32, u32), page: [f64; 2]) -> (Vec<(i64, i64, i64, i64)>, usize) {
    let (pw, ph) = (i64::from(physical.0), i64::from(physical.1));
    let scale = (f64::from(physical.0) / page[0]).min(f64::from(physical.1) / page[1]);
    let ox = (f64::from(physical.0) - page[0] * scale) / 2.;
    let oy = (f64::from(physical.1) - page[1] * scale) / 2.;
    let mut bands = Vec::new();
    let top = (oy.floor() as i64).min(ph);
    if top > 0 {
        bands.push((0, 0, pw, top));
    }
    let bottom = (oy + page[1] * scale).ceil() as i64;
    if bottom < ph {
        bands.push((0, bottom, pw, ph));
    }
    let left = (ox.floor() as i64).min(pw);
    if left > 0 {
        bands.push((0, 0, left, ph));
    }
    let right = (ox + page[0] * scale).ceil() as i64;
    if right < pw {
        bands.push((right, 0, pw, ph));
    }
    let total: i64 = bands.iter().map(|(x0, y0, x1, y1)| (x1 - x0) * (y1 - y0)).sum();
    (bands, total.max(0) as usize)
}

fn violations_in_bands(
    pixels: &[u8],
    physical: (u32, u32),
    bands: &[(i64, i64, i64, i64)],
) -> usize {
    // 只判 RGB：deep2d 管线的读回 alpha 平面全帧统一为 1（不透明呈现语义），
    // 不携带内容信息；bar 的内容语义 = 无颜色墨迹。
    let mut violations = 0usize;
    for &(x0, y0, x1, y1) in bands {
        for y in y0..y1 {
            for x in x0..x1 {
                let i = ((y as u32 * physical.0 + x as u32) * 4) as usize;
                if pixels[i] != 0 || pixels[i + 1] != 0 || pixels[i + 2] != 0 {
                    violations += 1;
                }
            }
        }
    }
    violations
}

struct BackendCtx {
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

fn make_instance(backend: wgpu::Backends) -> wgpu::Instance {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = backend;
    wgpu::Instance::new(descriptor)
}

async fn request_adapter(instance: &wgpu::Instance, label: &str) -> wgpu::Adapter {
    instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            ..Default::default()
        })
        .await
        .unwrap_or_else(|error| panic!("{label}: real GPU adapter request failed: {error}"))
}

fn adapter_json(info: &wgpu::AdapterInfo) -> Value {
    json!({
        "name": info.name,
        "vendorId": format!("0x{:04x}", info.vendor & 0xffff),
        "deviceId": format!("0x{:04x}", info.device & 0xffff),
        "deviceType": format!("{:?}", info.device_type),
        "pciBus": info.device_pci_bus_id,
        "driver": info.driver,
        "driverInfo": info.driver_info,
        "backend": format!("{:?}", info.backend),
    })
}

async fn make_ctx(backend: wgpu::Backends, label: &str) -> BackendCtx {
    let instance = make_instance(backend);
    let adapter = request_adapter(&instance, label).await;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .unwrap_or_else(|error| panic!("{label}: device request failed: {error}"));
    BackendCtx {
        adapter,
        device,
        queue,
    }
}

/// 与 bin 侧 draw_in_format_at 相同的读回管线（含 256B 行对齐处理），
/// 每格独立 validation error scope。
async fn draw_readback(
    ctx: &BackendCtx,
    content: &Deep2dRuntimeContent,
    cache: &Arc<Deep2dGpuAssetCache>,
    physical: (u32, u32),
) -> (Vec<u8>, Option<String>) {
    let validation = ctx.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let painter = Deep2dGpuPainter::new(&ctx.device, &ctx.queue, FORMAT, content, cache)
        .unwrap_or_else(|error| panic!("painter prepare failed: {error}"));
    let size = wgpu::Extent3d {
        width: physical.0,
        height: physical.1,
        depth_or_array_layers: 1,
    };
    let target = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("p03-04 readback target"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let mut encoder = ctx.device.create_command_encoder(&Default::default());
    {
        let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("p03-04 clear"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    }
    painter.draw(&mut encoder, &view, physical);
    let bytes_per_row = physical.0 * 4;
    let padded = bytes_per_row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("p03-04 readback buffer"),
        size: u64::from(padded) * u64::from(physical.1),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(physical.1),
            },
        },
        size,
    );
    ctx.queue.submit([encoder.finish()]);
    readback.map_async(wgpu::MapMode::Read, .., |result| {
        result.expect("readback map")
    });
    ctx.device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("device poll");
    let mapped = readback.get_mapped_range(..).expect("mapped range");
    let mut pixels = Vec::with_capacity(bytes_per_row as usize * physical.1 as usize);
    for row in 0..physical.1 {
        let start = row as usize * padded as usize;
        pixels.extend_from_slice(&mapped[start..start + bytes_per_row as usize]);
    }
    drop(mapped);
    readback.unmap();
    drop(painter);
    let validation_error = validation
        .pop()
        .await
        .map(|error| error.to_string());
    (pixels, validation_error)
}

fn pixel_stats(pixels: &[u8]) -> (usize, usize, String) {
    let mut colored = 0usize;
    let mut ink = 0usize;
    for pixel in pixels.chunks_exact(4) {
        if pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0 {
            colored += 1;
        }
        if pixel[3] >= 128 {
            ink += 1;
        }
    }
    (colored, ink, format!("fnv1a64:{:016x}", fnv1a64(pixels)))
}

struct DiffReport {
    diff_pixels: usize,
    max_delta: u32,
    bbox: [i64; 4],
    thresholds: Value,
}

/// 逐像素 diff（RGBA 各通道取最大差），输出阈值直方图与放大掩膜。
fn diff_pixels(
    a: &[u8],
    b: &[u8],
    physical: (u32, u32),
    out: &Path,
    name: &str,
) -> Result<DiffReport, String> {
    if a.len() != b.len() {
        return Err(format!("length mismatch {} vs {}", a.len(), b.len()));
    }
    let mut diff_count = 0usize;
    let mut max_delta = 0u32;
    let mut bbox = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
    let mut thresholds = [0usize; 8]; // >=1,2,4,8,16,32,64,128
    let mut mask = vec![0u8; a.len()];
    for y in 0..i64::from(physical.1) {
        for x in 0..i64::from(physical.0) {
            let i = ((y as u32 * physical.0 + x as u32) * 4) as usize;
            let delta = (0..4)
                .map(|c| (i32::from(a[i + c]) - i32::from(b[i + c])).unsigned_abs())
                .max()
                .unwrap_or(0);
            if delta == 0 {
                continue;
            }
            diff_count += 1;
            max_delta = max_delta.max(delta);
            bbox[0] = bbox[0].min(x);
            bbox[1] = bbox[1].min(y);
            bbox[2] = bbox[2].max(x);
            bbox[3] = bbox[3].max(y);
            for (slot, threshold) in thresholds.iter_mut().zip([1u32, 2, 4, 8, 16, 32, 64, 128]) {
                if delta >= threshold {
                    *slot += 1;
                }
            }
            mask[i] = (delta * 8).min(255) as u8;
            mask[i + 3] = 255;
        }
    }
    let bbox = if diff_count == 0 { [0, 0, 0, 0] } else { bbox };
    std::fs::create_dir_all(out.join("raw")).map_err(|e| e.to_string())?;
    std::fs::write(out.join("raw").join(format!("{name}.rgba")), &mask)
        .map_err(|error| format!("write mask: {error}"))?;
    let names = ["ge1", "ge2", "ge4", "ge8", "ge16", "ge32", "ge64", "ge128"];
    Ok(DiffReport {
        diff_pixels: diff_count,
        max_delta,
        bbox,
        thresholds: json!(names
            .iter()
            .zip(thresholds)
            .map(|(n, v)| (n.to_string(), Value::from(v)))
            .collect::<serde_json::Map<String, Value>>()),
    })
}

fn write_raw(out: &Path, id: &str, pixels: &[u8]) -> Result<(), String> {
    std::fs::write(out.join("raw").join(format!("{id}.rgba")), pixels)
        .map_err(|error| format!("write raw {id}: {error}"))
}

/// 读取冻结字体清单并加载字节（from_frozen_fonts 内部会重新校验 SHA-256）。
fn load_frozen_fonts(fonts_dir: &Path) -> Result<(Vec<FrozenFontInput>, Value), String> {
    let manifest_path = fonts_dir.join("fonts.json");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("read {}: {error}", manifest_path.display()))?;
    let parsed: Value =
        serde_json::from_str(&manifest).map_err(|error| format!("parse fonts.json: {error}"))?;
    let entries = parsed.as_array().ok_or("fonts.json must be an array")?;
    let mut inputs = Vec::new();
    let mut provenance = Vec::new();
    for entry in entries {
        let id = entry["id"].as_str().ok_or("font id missing")?.to_string();
        let path = entry["path"].as_str().ok_or("font path missing")?;
        let source = entry["source"].as_str().unwrap_or_default();
        let sha = source
            .split("sha256=")
            .nth(1)
            .map(|rest| rest.split([';', ',']).next().unwrap_or("").trim().to_string())
            .ok_or_else(|| format!("font {id}: sha256 missing in source"))?;
        if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(format!("font {id}: malformed sha256 {sha:?}"));
        }
        let bytes = std::fs::read(path).map_err(|error| format!("read font {id}: {error}"))?;
        inputs.push(FrozenFontInput {
            bytes,
            sha256: sha.clone(),
            face_index: 0,
        });
        provenance.push(json!({
            "id": id,
            "path": path,
            "sha256": sha,
            "weight": entry["layoutFace"]["weight"],
            "family": entry["layoutFace"]["family"],
        }));
    }
    if inputs.len() < 2 {
        return Err("fonts.json must provide regular and bold faces".into());
    }
    Ok((inputs, Value::Array(provenance)))
}

fn sha_for_weight(provenance: &Value, weight: u64) -> Result<String, String> {
    for entry in provenance.as_array().expect("provenance array") {
        if entry["weight"].as_u64() == Some(weight) {
            return Ok(entry["sha256"].as_str().expect("sha").to_string());
        }
    }
    Err(format!("no frozen face with weight {weight}"))
}

enum FontSpec {
    System {
        id: &'static str,
        text: &'static str,
        family: &'static str,
    },
    Frozen {
        id: &'static str,
        text: String,
        sha256: String,
        weight: u16,
    },
}

async fn run() -> Result<Value, String> {
    let args = parse_args();
    std::fs::create_dir_all(args.out.join("raw")).map_err(|e| e.to_string())?;

    // ---------- producer 包 ----------
    let package_bytes =
        std::fs::read(&args.package).map_err(|error| format!("read package: {error}"))?;
    let package = parse_and_validate_runtime_package(&package_bytes)
        .map_err(|error| format!("validate package: {error}"))?;
    let package_id = package.package_id.clone();
    let package_hash = package.package_hash.clone();
    let mut runtime = DashboardRuntime::new(
        package
            .dashboard
            .ok_or("package has no dashboard entrypoint")?,
    )
    .map_err(|error| format!("dashboard runtime: {error}"))?;
    let page = runtime.document().pages[0].clone();
    runtime
        .switch_page(&page.id)
        .map_err(|error| format!("switch page: {error}"))?;
    let page_logical = [page.width, page.height];
    let clipped_nodes: Vec<(String, [f64; 4])> = page
        .nodes
        .iter()
        .filter_map(|node| {
            node.clip.map(|clip| {
                (
                    node.id.clone(),
                    [
                        clip[0] + node.frame[0],
                        clip[1] + node.frame[1],
                        clip[2],
                        clip[3],
                    ],
                )
            })
        })
        .collect();
    println!(
        "package: id={package_id} pages={} page0={}x{} clippedLayers={}",
        runtime.document().pages.len(),
        page_logical[0],
        page_logical[1],
        clipped_nodes.len()
    );

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
                let violations =
                    i64::try_from(violations_in_bands(&pixels, physical, &bands)).unwrap_or(i64::MAX);
                (bands, bar_total, violations)
            };
            let mut clipped_report = Vec::new();
            for (node_id, rect) in &clipped_nodes {
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

    // ---------- 字体维度（Vulkan，960×540，1:1 无 letterbox） ----------
    let ctx = make_ctx(wgpu::Backends::VULKAN, "font-vulkan").await;
    let cache = Arc::new(Deep2dGpuAssetCache::new());
    let (frozen_inputs, frozen_provenance) = load_frozen_fonts(&args.fonts)?;
    let mut frozen = TextRasterizer::from_frozen_fonts("zh-CN", frozen_inputs.clone())
        .map_err(|error| format!("frozen fonts: {error}"))?;
    let mut system = TextRasterizer::new();
    let regular_sha = sha_for_weight(&frozen_provenance, 400)?;
    let bold_sha = sha_for_weight(&frozen_provenance, 700)?;

    let cjk_text = "泵站监控 25.6°C 深度";
    let latin_text = "Deep Monkey Studio 2026";
    let color = [240u8, 180, 60, 255];

    let specs = vec![
        FontSpec::System {
            id: "font-system-yahei",
            text: cjk_text,
            family: "Microsoft YaHei",
        },
        FontSpec::System {
            id: "font-system-segoe",
            text: latin_text,
            family: "Segoe UI",
        },
        FontSpec::Frozen {
            id: "font-frozen-noto-regular",
            text: cjk_text.to_string(),
            sha256: regular_sha.clone(),
            weight: 400,
        },
        FontSpec::Frozen {
            id: "font-frozen-noto-bold",
            text: "泵站告警阈值 8.5m".to_string(),
            sha256: bold_sha.clone(),
            weight: 700,
        },
    ];

    let mut font_cells = Vec::new();
    let mut font_snapshots: std::collections::BTreeMap<String, (Vec<u8>, (u32, u32))> =
        std::collections::BTreeMap::new();
    for spec in specs {
        let (cell_id, raster) = match &spec {
            FontSpec::System { id, text, family } => {
                let raster = system
                    .rasterize(TextRasterRequest {
                        text,
                        family,
                        font_size: 40.0,
                        line_height: 56.0,
                        width: CANVAS.0,
                        height: CANVAS.1,
                        color,
                    })
                    .map_err(|error| format!("font cell {id}: {error}"))?;
                (*id, raster)
            }
            FontSpec::Frozen {
                id,
                text,
                sha256,
                weight,
            } => {
                let request = StyledTextRequest {
                    text: text.clone(),
                    font: FrozenFontRef {
                        sha256: sha256.clone(),
                        face_index: 0,
                    },
                    weight: *weight,
                    style: TextFontStyle::Normal,
                    align: TextAlign::Left,
                    vertical_align: TextVerticalAlign::Top,
                    wrap: TextWrap::None,
                    font_size: 40.0,
                    line_height: 56.0,
                    width: CANVAS.0,
                    height: CANVAS.1,
                    color,
                };
                let styled = frozen
                    .rasterize_styled(request)
                    .map_err(|error| format!("font cell {id}: {error}"))?;
                (*id, RasterizedText {
                    width: styled.width,
                    height: styled.height,
                    rgba: styled.rgba,
                    glyph_count: styled.glyph_count,
                    line_count: styled.line_count,
                })
            }
        };
        if raster.glyph_count == 0 {
            return Err(format!("font cell {cell_id}: rasterized zero glyphs"));
        }
        let glyph_count = raster.glyph_count;
        let list = raster
            .into_display_list(
                cell_id,
                1,
                [f64::from(CANVAS.0), f64::from(CANVAS.1)],
                [24.0, 24.0],
                0,
            )
            .map_err(|error| format!("font cell {cell_id}: display list: {error}"))?;
        let content = Deep2dRuntimeContent::DisplayList(list);
        let (pixels, validation_error) = draw_readback(&ctx, &content, &cache, CANVAS).await;
        if let Some(error) = &validation_error {
            return Err(format!("{cell_id}: GPU validation error: {error}"));
        }
        write_raw(&args.out, cell_id, &pixels)?;
        let (colored, ink, checksum) = pixel_stats(&pixels);
        font_cells.push(json!({
            "id": cell_id,
            "group": "font",
            "backend": "vulkan",
            "physical": [CANVAS.0, CANVAS.1],
            "file": format!("raw/{cell_id}.rgba"),
            "checksum": checksum,
            "coloredPixels": colored,
            "inkPixels": ink,
            "glyphCount": glyph_count,
            "validationClean": true,
        }));
        font_snapshots.insert(cell_id.to_string(), (pixels, CANVAS));
    }

    // 字体回退 diff：同文本同字号，Microsoft YaHei vs 冻结 Noto Regular。
    let font_diff = {
        let (a, sa) = font_snapshots
            .get("font-system-yahei")
            .ok_or("missing font-system-yahei")?;
        let (b, sb) = font_snapshots
            .get("font-frozen-noto-regular")
            .ok_or("missing font-frozen-noto-regular")?;
        if sa != sb {
            return Err("font snapshots differ in size".into());
        }
        let report = diff_pixels(a, b, *sa, &args.out, "diff-font-yahei-vs-noto")?;
        json!({
            "a": "font-system-yahei",
            "b": "font-frozen-noto-regular",
            "sameText": cjk_text,
            "physical": [sa.0, sa.1],
            "diffPixels": report.diff_pixels,
            "maxChannelDelta": report.max_delta,
            "diffBbox": report.bbox,
            "maskFile": "raw/diff-font-yahei-vs-noto.rgba",
            "note": "两套字体同一文本的字形替换差异；两格各自须有足量墨迹（见 inkPixels）",
        })
    };

    // 字体能力探针（回退行为 + 缺字形 fail-closed）
    let emoji_request = |sha256: String| StyledTextRequest {
        text: "泵站🚀告警".to_string(),
        font: FrozenFontRef {
            sha256,
            face_index: 0,
        },
        weight: 400,
        style: TextFontStyle::Normal,
        align: TextAlign::Left,
        vertical_align: TextVerticalAlign::Top,
        wrap: TextWrap::None,
        font_size: 40.0,
        line_height: 56.0,
        width: CANVAS.0,
        height: CANVAS.1,
        color,
    };
    let frozen_emoji = frozen.rasterize_styled(emoji_request(regular_sha.clone()));
    let system_emoji = system.rasterize(TextRasterRequest {
        text: "泵站🚀告警",
        family: "Microsoft YaHei",
        font_size: 40.0,
        line_height: 56.0,
        width: CANVAS.0,
        height: CANVAS.1,
        color,
    });
    let font_probes = json!({
        "systemFamilies": {
            "microsoftYaHei": system.family_exists("Microsoft YaHei"),
            "segoeUi": system.family_exists("Segoe UI"),
            "notoSansCjkSc": system.family_exists("Noto Sans CJK SC"),
            "definitelyMissing": system.family_exists("Definitely Missing Family"),
        },
        "frozenDb": {
            "isolatedFromSystem": true,
            "faces": frozen_provenance,
            "regularFaceRendersCjk": font_cells.iter().any(|cell| cell["id"] == json!("font-frozen-noto-regular") && cell["inkPixels"].as_u64().unwrap_or(0) > 100),
        },
        "missingGlyphFailClosed": {
            "probeText": "泵站🚀告警",
            "frozenOutcome": match &frozen_emoji {
                Ok(_) => json!({"rendered": true, "failClosed": false}),
                Err(error) => json!({"rendered": false, "failClosed": true, "error": error}),
            },
            "systemOutcome": match &system_emoji {
                Ok(raster) => json!({"rendered": true, "glyphCount": raster.glyph_count,
                    "note": "系统路径可经已装字体静默回退（如 Segoe UI Emoji）；需像素级复核，与冻结路径的硬失败不同"}),
                Err(error) => json!({"rendered": false, "failClosed": true, "error": error}),
            },
        },
    });

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
            return Err(format!("device loss {label}: rebuild draw validation: {error}"));
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

    Ok(json!({
        "schema": "p03-04-device-matrix-raw",
        "generatedAtEpochSecs": now_epoch_secs(),
        "package": {
            "path": args.package.display().to_string(),
            "bytes": package_bytes.len(),
            "packageId": package_id,
            "packageHash": package_hash,
            "pages": runtime.document().pages.len(),
            "pageLogical": page_logical,
            "clippedLayerCount": clipped_nodes.len(),
        },
        "adapters": Value::Object(adapters),
        "cells": cells,
        "backendDiff": backend_diff,
        "sizeConsistency": size_consistency,
        "fontCells": font_cells,
        "fontDiff": font_diff,
        "fontProbes": font_probes,
        "deviceLoss": Value::Object(device_loss),
    }))
}

fn main() {
    let args = parse_args();
    let result = pollster::block_on(run());
    let document = match result {
        Ok(value) => value,
        Err(error) => json!({
            "schema": "p03-04-device-matrix-raw",
            "generatedAtEpochSecs": now_epoch_secs(),
            "fatalError": error,
        }),
    };
    let path = args.out.join("matrix_raw.json");
    std::fs::create_dir_all(&args.out).expect("create output dir");
    std::fs::write(&path, serde_json::to_vec_pretty(&document).expect("serialize"))
        .expect("write matrix_raw.json");
    if document.get("fatalError").is_some() {
        eprintln!("P03-04 HARNESS FAILED: {}", document["fatalError"]);
        std::process::exit(1);
    }
    println!("matrix_raw.json written to {}", path.display());
}
