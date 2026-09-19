//! R6-2 A1 裁决:生成真实文字工作负载的 Deep2D runtime fixture。
//!
//! 文字全部来自生产链路:8 系列 × 8192 行 chart IR(结构与 chart_e2e_perf 夹具一致,
//! 类目标签换成 ~300 常用汉字池以满足 CJK+ASCII+数字覆盖)→ ChartRuntime →
//! `ChartAction::Hover` 武装真实 tooltip → `present_chart`(cosmic-text shaping +
//! swash 栅格化 + 整段 RGBA atlas base64)。fixture 截取 overlay 文字切片
//! (tooltip + 轴标签 + 图例 + 状态描边),不含 8192 点系列折线的重几何——
//! 文字 prepare 的对照口径。
//!
//! 输出:
//! - packages/deep-engine-native/fixtures/deep2d_runtime_chart_text_v1.json(可用
//!   DEEP_TEXT_FIXTURE_OUT 覆盖输出路径)
//! - stdout 打印 manifest JSON(文字量、字符集、atlas bytes、prepare 冒烟摘要)。
//!
//! 运行:cargo run --release --manifest-path packages/deep-engine-native/Cargo.toml
//!   --example gen_deep2d_text_fixture
use deep_engine_native::{
    chart::{
        ChartAction, ChartIR, ChartRuntime, axis_render, legend_render, parse_chart_ir,
        presentation::present_chart, state_render, tooltip_render,
    },
    deep2d::{
        Deep2dCommand, Deep2dDisplayList, Deep2dResource, decode_runtime_content,
        prepare_runtime_content, validate_display_list,
    },
    native_ui::design_tokens::{DesignTokenSnapshot, validate_design_tokens},
    platform_text::TextRasterizer,
};
use serde_json::json;
use std::time::Instant;

const ROWS: usize = 8192;
const SERIES: usize = 8;
const WIDTH: f64 = 1280.0;
const HEIGHT: f64 = 720.0;
/// ~300 常用汉字池(工业仪表盘语域);生成器去重后按 row 取模作类目名,保证
/// fixture 覆盖 CJK+ASCII("-")+数字(行号)三种字符面。
const CJK_POOL: &str = "工业制造设备运行状态监控温度压力流量转速振动电流电压功率效率系统平台数据管理控制报警异常正常在线离线连接断开启动停止暂停复位紧急故障维修保养检查测试验证质量安全生产环境影响能耗碳排放班组车间工厂生产线工位订单计划排程进度完成率合格不良返工库存物料采购供应仓库物流运输配送客户销售市场服务反馈满意度合同价格成本利润预算收入支出资产财务人员考勤培训技能岗位部门组织架构权限角色登录加密备份恢复网络服务器数据库存储计算云端边缘节点采集传感器仪表执行器阀门电机泵风机压缩锅炉管道罐塔反应输送带机械手臂视觉识别定位导航路径避让调度优化算法模型训练预测分析报表图表趋势同比环比汇总平最值阈区间分布占比排名历史当前未来版本状态备注说明标题单位精度阈值上限下限默认参数配置项开关按钮输入输出端口地址协议波特率延迟丢包重试超时队列缓冲压缩解密签名校验完整一致可用可靠稳定健壮灵活扩展兼容移植文档注释日志跟踪调试发布部署回滚升级迁移同步异步并行串行阻塞非缓急轻重缓求条件循环分支递归迭代收敛发散梯度矩阵向量维数轴刻度标签图例提示框悬浮点击拖拽缩放平移聚焦隐藏显示切换联动画布栅格矢量像素清晰模糊对齐边距间距字号粗细斜体颜色透明度阴影圆角边框背景前景主题风格";

fn make_ir_text(shift: usize) -> ChartIR {
    let pool: Vec<char> = CJK_POOL.chars().collect();
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = true;
    let proto_series = ir
        .series
        .iter()
        .find(|series| series.id == "line")
        .cloned()
        .unwrap();
    let proto_data = ir.datasets[0].clone();
    ir.series.clear();
    ir.datasets.clear();
    for i in 0..SERIES {
        let mut data = proto_data.clone();
        data.id = format!("dataset-{i}");
        data.rows = (0..ROWS)
            .map(|row| {
                // 类目名 = 常用汉字 + "-" + 行号:CJK/ASCII/数字三面齐备。
                let label = format!(
                    "{}-{}",
                    pool[row % pool.len()],
                    row
                );
                vec![
                    json!(label),
                    json!(((row as f64) * 0.1).sin() * 3.0 + 4.0 + shift as f64),
                    json!(0.5 + shift as f64),
                    json!("中文标签"),
                ]
            })
            .collect();
        let dataset_id = data.id.clone();
        ir.datasets.push(data);
        let mut series = proto_series.clone();
        series.id = format!("series-{i}");
        series.label = format!("系列-{i}");
        series.dataset_id = dataset_id;
        ir.series.push(series);
    }
    ir
}

/// slice 命令引用到的资源 id 集合(path/image/font + clip 引用)。
fn referenced_ids(list: &Deep2dDisplayList) -> std::collections::BTreeSet<String> {
    let mut ids = std::collections::BTreeSet::new();
    for command in &list.commands {
        match command {
            Deep2dCommand::Path(path) => {
                ids.insert(path.path_id.clone());
                if let Some(clips) = &path.clip_path_ids {
                    ids.extend(clips.iter().cloned());
                }
            }
            Deep2dCommand::Text(text) => {
                ids.insert(text.font_id.clone());
                if let Some(atlas) = &text.atlas_id {
                    ids.insert(atlas.clone());
                }
                if let Some(clips) = &text.clip_path_ids {
                    ids.extend(clips.iter().cloned());
                }
            }
            Deep2dCommand::Image(image) => {
                ids.insert(image.image_id.clone());
                if let Some(atlas) = &image.atlas_id {
                    ids.insert(atlas.clone());
                }
                if let Some(clips) = &image.clip_path_ids {
                    ids.extend(clips.iter().cloned());
                }
            }
        }
    }
    ids
}

/// 截取 overlay 文字切片:去掉 baseline 几何命令与未被引用的重资源
/// (8192 点系列折线 verbs),保留 tooltip/轴/图例/状态描边全量文字工作负载。
fn overlay_slice(full: &Deep2dDisplayList, base: &Deep2dDisplayList) -> Deep2dDisplayList {
    let keep = referenced_ids(full);
    let mut sliced = full.clone();
    sliced.commands = full.commands[base.commands.len()..].to_vec();
    sliced.resources = full
        .resources
        .iter()
        .filter(|resource| {
            let id = match resource {
                Deep2dResource::Path(path) => &path.id,
                Deep2dResource::Font(font) => &font.id,
                Deep2dResource::Image(image) => &image.id,
            };
            keep.contains(id)
        })
        .cloned()
        .collect();
    sliced.atlases = full
        .atlases
        .iter()
        .filter(|atlas| keep.contains(&atlas.id))
        .cloned()
        .collect();
    sliced.id = "native:deep2d:chart-text-workload".into();
    sliced.revision = sliced.revision.max(1);
    sliced
}

fn count_text_image_commands(list: &Deep2dDisplayList) -> usize {
    list.commands
        .iter()
        .filter(|command| matches!(command, Deep2dCommand::Image(_)))
        .count()
}

fn atlas_bytes(list: &Deep2dDisplayList) -> usize {
    list.atlases
        .iter()
        .map(|atlas| atlas.width as usize * atlas.height as usize * 4)
        .sum()
}

fn main() {
    let started = Instant::now();
    let ir = make_ir_text(0);
    let mut chart = ChartRuntime::new(ir, WIDTH, HEIGHT).unwrap();
    let base = chart.frame().display_list().clone();
    let (base_commands, base_resources, base_atlases) = (
        base.commands.len(),
        base.resources.len(),
        base.atlases.len(),
    );
    let hover_index = 0usize;
    let pool: Vec<char> = CJK_POOL.chars().collect();
    let heading = format!("{}-{}", pool[hover_index % pool.len()], hover_index);
    chart
        .dispatch(ChartAction::Hover {
            series_id: "series-0".into(),
            data_index: hover_index,
            x_label: heading.clone(),
            value: "4.00".into(),
        })
        .map(|_| ())
        .unwrap();

    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    validate_design_tokens(&tokens).unwrap();

    let font_init = Instant::now();
    let mut rasterizer = TextRasterizer::new();
    let font_init_ms = font_init.elapsed().as_secs_f64() * 1000.0;

    // 分段计时(与 presentation.rs compose 同序)+ 全链计时。
    rasterizer.start_profile();
    let t = Instant::now();
    let mut list =
        tooltip_render::compose_tooltip(&chart, &mut rasterizer, &tokens.themes.dark, [100.0, 100.0])
            .unwrap();
    let tooltip_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    axis_render::append_axes(&mut list, &chart, &mut rasterizer, &tokens.themes.dark).unwrap();
    let axes_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    state_render::append_state_outlines(&mut list, &chart, &tokens.themes.dark).unwrap();
    let state_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    legend_render::append_legend(
        &mut list,
        &chart,
        &mut rasterizer,
        &tokens.themes.dark,
        0,
        None,
    )
    .unwrap();
    let legend_ms = t.elapsed().as_secs_f64() * 1000.0;
    let profile = rasterizer.profile().cloned().unwrap();

    let t = Instant::now();
    let full = present_chart(&chart, &mut rasterizer, 0, [100.0, 100.0], None).unwrap();
    let present_ms = t.elapsed().as_secs_f64() * 1000.0;

    let sliced = overlay_slice(&full, &base);
    let validation = validate_display_list(&sliced);
    assert!(
        validation.valid,
        "overlay slice must validate: {:?}",
        validation.issues
    );

    // prepare 冒烟(与基准同口径),把 quad/顶点/chunk 证据写进 manifest。
    let payload = serde_json::to_vec(&sliced).unwrap();
    let content = decode_runtime_content(&payload).unwrap();
    let prepared = prepare_runtime_content(&content).unwrap();
    let summary = prepared.summary.clone();

    let out_path = std::env::var_os("DEEP_TEXT_FIXTURE_OUT").map_or_else(
        || {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures/deep2d_runtime_chart_text_v1.json")
        },
        std::path::PathBuf::from,
    );
    // 紧凑单行序列化:atlas base64 占绝对体积,pretty 缩进只会虚增行数(≤800 行纪律)。
    let pretty = serde_json::to_string(&sliced).unwrap();
    std::fs::write(&out_path, pretty.as_bytes()).unwrap();

    // 字符集证据:渲染字符串中可精确重建的部分(tooltip/图例/类目池),
    // y 轴数字刻度在 fixture 像素内、不在字符串证据里,如实声明。
    let known_strings: Vec<String> = (0..SERIES)
        .map(|i| format!("系列-{i}"))
        .chain(std::iter::once(format!("{heading}: 4.00")))
        .chain((0..ROWS).step_by(ROWS.div_ceil(12)).map(|row| {
            format!("{}-{}", pool[row % pool.len()], row)
        }))
        .chain(std::iter::once("中文标签".to_string()))
        .collect();
    let mut cjk = std::collections::BTreeSet::new();
    let mut ascii = std::collections::BTreeSet::new();
    let mut digits = std::collections::BTreeSet::new();
    for text in &known_strings {
        for ch in text.chars() {
            if ch.is_ascii() {
                if ch.is_ascii_digit() {
                    digits.insert(ch);
                } else {
                    ascii.insert(ch);
                }
            } else {
                cjk.insert(ch);
            }
        }
    }

    println!(
        "{}",
        json!({
            "manifest": "deep2d-runtime-chart-text-fixture-v1",
            "fixture": out_path.to_string_lossy(),
            "fixtureBytes": std::fs::metadata(&out_path).unwrap().len(),
            "pipeline": "ChartRuntime(8 series x 8192 rows) + Hover -> present_chart(cosmic-text shaping + swash raster -> RGBA atlas base64)",
            "fontInitColdMs": font_init_ms,
            "stageMsFirstFrame": {"tooltip": tooltip_ms, "axes": axes_ms, "state": state_ms, "legend": legend_ms, "presentTotal": present_ms},
            "rasterProfileFirstFrame": profile,
            "baseFrame": {"commands": base_commands, "resources": base_resources, "atlases": base_atlases},
            "slice": {
                "commands": sliced.commands.len(),
                "resources": sliced.resources.len(),
                "atlases": sliced.atlases.len(),
                "textRunQuads": count_text_image_commands(&sliced),
                "atlasBytesDecoded": atlas_bytes(&sliced),
            },
            "preparedSummary": {
                "atlases": summary.atlases,
                "atlasBytes": summary.atlas_bytes,
                "imageQuads": summary.image_quads,
                "glyphQuads": summary.glyph_quads,
                "atlasBatches": summary.atlas_batches,
                "atlasVertices": summary.atlas_vertices,
                "renderChunks": summary.render_chunks,
                "pathVertices": summary.path.vertices,
            },
            "charsetEvidence": {
                "cjkPoolDistinct": pool.iter().collect::<std::collections::BTreeSet<_>>().len(),
                "knownRenderedStrings": known_strings,
                "knownStringsDistinctCjk": cjk.len(),
                "knownStringsDistinctAscii": ascii.len(),
                "knownStringsDistinctDigits": digits.len(),
                "note": "y 轴数字刻度与省略号截断属于像素证据,不在字符串清单;类目标签池覆盖常用汉字,行号提供数字面",
            },
            "generationMsTotal": started.elapsed().as_secs_f64() * 1000.0,
        })
    );
}
