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

#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_atlas_gpu.rs"]
pub mod deep2d_atlas_gpu;
#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_gpu.rs"]
pub mod deep2d_gpu;
#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_gpu_cache.rs"]
pub mod deep2d_gpu_cache;
#[path = "D:/Documents/bim/bim-studio/packages/deep-engine-native/src/deep2d_scissor.rs"]
pub mod deep2d_scissor;

mod backend_matrix;
mod font_matrix;
mod font_source;
mod gpu;
mod pixels;
mod recovery;
use gpu::*;
use pixels::*;

use deep2d_gpu::Deep2dGpuPainter;
use deep2d_gpu_cache::Deep2dGpuAssetCache;

use deep_engine_native::dashboard_runtime::DashboardRuntime;
use deep_engine_native::deep2d::Deep2dRuntimeContent;
use deep_engine_native::platform_text::StyledTextRequest;
use deep_engine_native::platform_text::{
    FrozenFontInput, FrozenFontRef, RasterizedText, TextAlign, TextFontStyle, TextRasterRequest,
    TextRasterizer, TextVerticalAlign, TextWrap,
};
use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
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

    let (adapters, cells, backend_diff, size_consistency) =
        backend_matrix::run(&args, &runtime, page_logical, &clipped_nodes).await?;

    let (font_cells, font_diff, font_probes) = font_matrix::run_fonts(&args).await?;

    let device_loss = recovery::run_recovery(&args, &runtime).await?;

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
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&document).expect("serialize"),
    )
    .expect("write matrix_raw.json");
    if document.get("fatalError").is_some() {
        eprintln!("P03-04 HARNESS FAILED: {}", document["fatalError"]);
        std::process::exit(1);
    }
    println!("matrix_raw.json written to {}", path.display());
}
