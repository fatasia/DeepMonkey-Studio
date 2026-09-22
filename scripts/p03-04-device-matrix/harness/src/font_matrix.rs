//! System and frozen font rendering and missing-glyph probes.
use super::font_source::*;
use super::*;

pub(super) async fn run_fonts(args: &Args) -> Result<(Vec<Value>, Value, Value), String> {
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
                (
                    *id,
                    RasterizedText {
                        width: styled.width,
                        height: styled.height,
                        rgba: styled.rgba,
                        glyph_count: styled.glyph_count,
                        line_count: styled.line_count,
                    },
                )
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

    Ok((font_cells, font_diff, font_probes))
}
