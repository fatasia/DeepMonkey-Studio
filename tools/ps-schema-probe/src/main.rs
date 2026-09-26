//! ps-schema-probe —— Parasolid X_T/X_B 结构探针 CLI(薄包装,不实现解析)。
//!
//! 职责边界(2026-09-26 定案):
//! - census 模式(无 catalog):只读头部(inspect_xt / inspect_xb),验证结构与 schema key;
//!   trim 拓扑不解码,输出如实注明。
//! - schema-aware 模式(提供部署方自备的官方 schema catalog 文本):经 parasolid-core
//!   的 parse_schema_catalog + parse_xt/parse_xb 链做全节点解析,输出全节点类型计数;
//!   `--brep` 追加权威 B-Rep 拓扑摘要(face/loop/edge/vertex 等)。
//! - 本工具只做结构证据输出;几何三角化(B-Rep → mesh)不在本工具范围。
//!
//! schema catalog 是 Parasolid 版权件,不能随包交付;部署方自备路径由调用方传入。

use std::{
    collections::BTreeMap,
    env, fs,
    io::Write,
    process::ExitCode,
};

use parasolid_core::brep::{BrepModel, map_xb_brep, map_xt_brep};
use parasolid_core::{
    BuiltinProfileRegistry, DocumentLimits, InspectionLimits, InMemorySchemaProvider,
    SchemaCatalogLimits, SchemaKey, SchemaProvider, inspect_xb, inspect_xt, parse_schema_catalog,
    parse_xb, parse_xt,
};
use serde::Serialize;

const TOOL_NAME: &str = "ps-schema-probe";
const TOOL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 与 vendored examples/trim_coverage.rs 的生产级资源上限保持一致。
const DOCUMENT_LIMITS: DocumentLimits = DocumentLimits {
    max_file_size: 256 * 1024 * 1024,
    max_nodes: 2_000_000,
    max_schema_types: 1_048_576,
    max_fields_per_type: 4_096,
    max_string_bytes: 1_048_576,
    max_variable_elements: 4_194_304,
};

const INSPECTION_LIMITS: InspectionLimits = InspectionLimits {
    max_file_size: 256 * 1024 * 1024,
    max_string_bytes: 16 * 1024 * 1024,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceFormat {
    Text,
    Binary,
}

impl SourceFormat {
    const fn label(self) -> &'static str {
        match self {
            Self::Text => "x_t",
            Self::Binary => "x_b",
        }
    }
}

#[derive(Debug, Serialize)]
struct ProbeReport {
    tool: &'static str,
    version: &'static str,
    #[serde(rename = "sourceFormat")]
    source_format: &'static str,
    mode: &'static str,
    #[serde(rename = "fileSize")]
    file_size: usize,
    #[serde(rename = "schemaKey")]
    schema_key: String,
    #[serde(rename = "modellerVersion")]
    modeller_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<CatalogSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    census: Option<CensusSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    brep: Option<BrepSummary>,
}

#[derive(Debug, Serialize)]
struct CatalogSummary {
    #[serde(rename = "schemaId")]
    schema_id: String,
    #[serde(rename = "modellerVersion")]
    modeller_version: String,
    #[serde(rename = "definitionCount")]
    definition_count: usize,
}

#[derive(Debug, Serialize)]
struct CensusSummary {
    #[serde(rename = "recordCount")]
    record_count: usize,
    #[serde(rename = "nodeTypeCounts")]
    node_type_counts: BTreeMap<u16, usize>,
}

#[derive(Debug, Serialize)]
struct BrepSummary {
    complete: bool,
    bodies: usize,
    regions: usize,
    shells: usize,
    faces: usize,
    loops: usize,
    #[serde(rename = "halfEdges")]
    half_edges: usize,
    edges: usize,
    vertices: usize,
    points: usize,
    curves: usize,
    surfaces: usize,
    #[serde(rename = "surfaceKinds")]
    surface_kinds: BTreeMap<&'static str, usize>,
    #[serde(rename = "boundingBox", skip_serializing_if = "Option::is_none")]
    bounding_box: Option<BoundingBoxReport>,
    diagnostics: usize,
    #[serde(rename = "topologyValid")]
    topology_valid: bool,
    #[serde(rename = "eulerCharacteristic")]
    euler_characteristic: i64,
}

#[derive(Debug, Serialize)]
struct BoundingBoxReport {
    min: [f64; 3],
    max: [f64; 3],
}

struct Arguments {
    file: Option<String>,
    schema_catalog: Option<String>,
    builtin_profile: bool,
    brep: bool,
    json: bool,
    format: Option<SourceFormat>,
}

fn main() -> ExitCode {
    let arguments = match parse_arguments(env::args().skip(1).collect()) {
        Ok(arguments) => arguments,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    let Some(file) = arguments.file.clone() else {
        eprintln!("usage: ps-schema-probe --file <model.x_t|x_b> [--schema-catalog <catalog.txt>] [--brep] [--json] [--format x_t|x_b]");
        return ExitCode::from(2);
    };
    match run(&file, &arguments) {
        Ok(report) => {
            if arguments.json {
                match serde_json::to_string_pretty(&report) {
                    Ok(text) => {
                        let mut stdout = std::io::stdout().lock();
                        let _ = stdout.write_all(text.as_bytes());
                        let _ = stdout.write_all(b"\n");
                        ExitCode::SUCCESS
                    }
                    Err(error) => fail(&format!("JSON 序列化失败：{error}")),
                }
            } else {
                print_text_report(&report);
                ExitCode::SUCCESS
            }
        }
        Err(error) => fail(&error),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{TOOL_NAME}: {message}");
    ExitCode::FAILURE
}

fn parse_arguments(values: Vec<String>) -> Result<Arguments, String> {
    let mut arguments = Arguments {
        file: None,
        schema_catalog: None,
        builtin_profile: false,
        brep: false,
        json: false,
        format: None,
    };
    let mut index = 0;
    while index < values.len() {
        let flag = values[index].as_str();
        match flag {
            "--file" => arguments.file = Some(take_value(&values, &mut index, flag)?),
            "--schema-catalog" => arguments.schema_catalog = Some(take_value(&values, &mut index, flag)?),
            "--builtin-profile" => arguments.builtin_profile = true,
            "--brep" => arguments.brep = true,
            "--json" => arguments.json = true,
            "--format" => {
                let value = take_value(&values, &mut index, flag)?;
                arguments.format = Some(match value.as_str() {
                    "x_t" => SourceFormat::Text,
                    "x_b" => SourceFormat::Binary,
                    other => return Err(format!("未知 --format 值：{other}（支持 x_t / x_b）")),
                });
            }
            other => return Err(format!("未知参数：{other}")),
        }
        index += 1;
    }
    if arguments.brep && arguments.schema_catalog.is_none() && !arguments.builtin_profile {
        return Err("--brep 需要 --schema-catalog 或 --builtin-profile（权威 B-Rep 映射依赖 schema 来源）".into());
    }
    if arguments.builtin_profile && arguments.schema_catalog.is_some() {
        return Err("--builtin-profile 与 --schema-catalog 互斥".into());
    }
    Ok(arguments)
}

fn take_value(values: &[String], index: &mut usize, flag: &str) -> Result<String, String> {
    match values.get(*index + 1) {
        Some(value) if !value.starts_with("--") => {
            *index += 1;
            Ok(value.clone())
        }
        _ => Err(format!("{flag} 缺少参数值")),
    }
}

fn run(file: &str, arguments: &Arguments) -> Result<ProbeReport, String> {
    let bytes = fs::read(file).map_err(|error| format!("读取 {file} 失败：{error}"))?;
    let source_format = match arguments.format {
        Some(format) => format,
        None => sniff_source_format(&bytes)
            .ok_or_else(|| format!("无法从文件头识别 Parasolid 传输格式（既非 X_T 文本也非 X_B PS 签名）：{file}"))?,
    };
    let header = inspect_header(&bytes, source_format)?;
    if arguments.schema_catalog.is_none() && !arguments.builtin_profile {
        return Ok(ProbeReport {
            tool: TOOL_NAME,
            version: TOOL_VERSION,
            source_format: source_format.label(),
            mode: "census",
            file_size: bytes.len(),
            schema_key: header.schema_key,
            modeller_version: header.modeller_version,
            note: Some("census 模式（未提供 schema catalog）：仅头部结构验证；trim 拓扑未解码"),
            catalog: None,
            census: None,
            brep: None,
        });
    }
    let selection = match &arguments.schema_catalog {
        Some(catalog_path) => catalog_selection(catalog_path)?,
        None => builtin_selection(&header.schema_key)?,
    };
    let census = match &selection {
        ProviderSelection::Catalog(provider, _) => count_nodes(&bytes, source_format, provider)?,
        ProviderSelection::Builtin(provider, _) => count_nodes(&bytes, source_format, provider)?,
    };
    let brep = if arguments.brep {
        let model = match &selection {
            ProviderSelection::Catalog(provider, _) => map_brep(&bytes, source_format, provider)?,
            ProviderSelection::Builtin(provider, _) => map_brep(&bytes, source_format, provider)?,
        };
        Some(brep_summary(&model))
    } else {
        None
    };
    let catalog = match selection {
        ProviderSelection::Catalog(_, catalog) | ProviderSelection::Builtin(_, catalog) => catalog,
    };
    Ok(ProbeReport {
        tool: TOOL_NAME,
        version: TOOL_VERSION,
        source_format: source_format.label(),
        mode: "schema-aware",
        file_size: bytes.len(),
        schema_key: header.schema_key,
        modeller_version: header.modeller_version,
        note: None,
        catalog: Some(catalog),
        census: Some(census),
        brep,
    })
}

enum ProviderSelection<'a> {
    Catalog(InMemorySchemaProvider, CatalogSummary),
    Builtin(parasolid_core::BuiltinSchemaProvider<'a>, CatalogSummary),
}

fn catalog_selection(catalog_path: &str) -> Result<ProviderSelection<'static>, String> {
    let catalog_bytes =
        fs::read(catalog_path).map_err(|error| format!("读取 catalog {catalog_path} 失败：{error}"))?;
    let parsed = parse_schema_catalog(&catalog_bytes, SchemaCatalogLimits::default())
        .map_err(|error| format!("schema catalog 解析失败：{error}"))?;
    let summary = CatalogSummary {
        schema_id: parsed.schema_id.clone(),
        modeller_version: parsed.modeller_version.clone(),
        definition_count: parsed.definitions.len(),
    };
    let mut provider = InMemorySchemaProvider::new();
    provider.add_schema(parsed.schema_id.clone());
    for definition in &parsed.definitions {
        provider.insert(parsed.schema_id.clone(), definition.clone());
    }
    Ok(ProviderSelection::Catalog(provider, summary))
}

fn builtin_selection(schema_key: &str) -> Result<ProviderSelection<'static>, String> {
    let registry = BuiltinProfileRegistry::compiled()
        .map_err(|error| format!("内置 schema profile 注册表不可用：{error}"))?;
    let key = SchemaKey::parse(schema_key).map_err(|error| format!("schema key 非法：{error}"))?;
    let provider = registry
        .provider_for_key(&key)
        .ok_or_else(|| format!("无内置 profile 覆盖 schema key {schema_key}（内置档仅覆盖 kit 验证子集）"))?;
    let summary = CatalogSummary {
        schema_id: format!("builtin:{}", provider.profile().metadata().profile_id),
        modeller_version: provider.profile().metadata().provider_schema.clone(),
        definition_count: provider.profile().definitions().count(),
    };
    Ok(ProviderSelection::Builtin(provider, summary))
}

struct HeaderSummary {
    schema_key: String,
    modeller_version: String,
}

fn inspect_header(bytes: &[u8], source_format: SourceFormat) -> Result<HeaderSummary, String> {
    let summary = match source_format {
        SourceFormat::Text => {
            let header = inspect_xt(bytes, INSPECTION_LIMITS)
                .map_err(|error| format!("X_T 头部解析失败：{error}"))?;
            (header.schema_key, header.modeller_version)
        }
        SourceFormat::Binary => {
            let header = inspect_xb(bytes, INSPECTION_LIMITS)
                .map_err(|error| format!("X_B 头部解析失败：{error}"))?;
            (header.schema_key, header.modeller_version)
        }
    };
    Ok(HeaderSummary { schema_key: summary.0, modeller_version: summary.1 })
}

fn count_nodes<P: SchemaProvider>(
    bytes: &[u8],
    source_format: SourceFormat,
    provider: &P,
) -> Result<CensusSummary, String> {
    let (record_count, counts) = match source_format {
        SourceFormat::Text => {
            let document = parse_xt(bytes, provider, DOCUMENT_LIMITS)
                .map_err(|error| format!("X_T 全节点解析失败：{error}"))?;
            (document.nodes.len(), type_counts(document.nodes.iter().map(|node| node.node_type)))
        }
        SourceFormat::Binary => {
            let document = parse_xb(bytes, provider, DOCUMENT_LIMITS)
                .map_err(|error| format!("X_B 全节点解析失败：{error}"))?;
            (document.nodes.len(), type_counts(document.nodes.iter().map(|node| node.node_type)))
        }
    };
    Ok(CensusSummary { record_count, node_type_counts: counts })
}

fn type_counts(types: impl Iterator<Item = u16>) -> BTreeMap<u16, usize> {
    types.fold(BTreeMap::new(), |mut counts, node_type| {
        *counts.entry(node_type).or_default() += 1;
        counts
    })
}

fn map_brep<P: SchemaProvider>(
    bytes: &[u8],
    source_format: SourceFormat,
    provider: &P,
) -> Result<BrepModel, String> {
    match source_format {
        SourceFormat::Text => {
            let document = parse_xt(bytes, provider, DOCUMENT_LIMITS)
                .map_err(|error| format!("X_T 全节点解析失败：{error}"))?;
            map_xt_brep(&document).map_err(|error| format!("X_T B-Rep 映射失败：{error}"))
        }
        SourceFormat::Binary => {
            let document = parse_xb(bytes, provider, DOCUMENT_LIMITS)
                .map_err(|error| format!("X_B 全节点解析失败：{error}"))?;
            map_xb_brep(&document).map_err(|error| format!("X_B B-Rep 映射失败：{error}"))
        }
    }
}

fn brep_summary(model: &BrepModel) -> BrepSummary {
    let mut surface_kinds = BTreeMap::<&'static str, usize>::new();
    for surface in &model.surfaces {
        *surface_kinds.entry(surface.kind.as_str()).or_default() += 1;
    }
    BrepSummary {
        complete: model.complete,
        bodies: model.bodies.len(),
        regions: model.regions.len(),
        shells: model.shells.len(),
        faces: model.faces.len(),
        loops: model.loops.len(),
        half_edges: model.half_edges.len(),
        edges: model.edges.len(),
        vertices: model.vertices.len(),
        points: model.points.len(),
        curves: model.curves.len(),
        surfaces: model.surfaces.len(),
        surface_kinds,
        bounding_box: model.metrics.bounding_box.map(|bounds| BoundingBoxReport {
            min: [bounds.minimum.x, bounds.minimum.y, bounds.minimum.z],
            max: [bounds.maximum.x, bounds.maximum.y, bounds.maximum.z],
        }),
        diagnostics: model.diagnostics.len(),
        topology_valid: model.topology.valid,
        euler_characteristic: model.topology.euler_characteristic,
    }
}

fn sniff_source_format(bytes: &[u8]) -> Option<SourceFormat> {
    if bytes.len() >= 4 && &bytes[..2] == b"PS" && bytes[2] == 0 && bytes[3] == 0 {
        return Some(SourceFormat::Binary);
    }
    match bytes.first() {
        Some(b'*') | Some(b'T') => Some(SourceFormat::Text),
        _ => None,
    }
}

fn print_text_report(report: &ProbeReport) {
    println!("tool\t{} v{}", report.tool, report.version);
    println!("file\t{} bytes ({})", report.file_size, report.source_format);
    println!("mode\t{}", report.mode);
    println!("schema\t{}", report.schema_key);
    if let Some(catalog) = &report.catalog {
        println!(
            "catalog\t{} ({}) definitions={}",
            catalog.schema_id, catalog.modeller_version, catalog.definition_count
        );
    }
    if let Some(census) = &report.census {
        println!("nodes\t{}", census.record_count);
        for (class, count) in &census.node_type_counts {
            println!("type\t{class}\t{count}");
        }
    }
    if let Some(brep) = &report.brep {
        println!(
            "brep\tcomplete={} bodies={} shells={} faces={} loops={} edges={} vertices={}",
            brep.complete, brep.bodies, brep.shells, brep.faces, brep.loops, brep.edges, brep.vertices
        );
        for (kind, count) in &brep.surface_kinds {
            println!("surface\t{kind}\t{count}");
        }
    }
    if let Some(note) = report.note {
        println!("note\t{note}");
    }
}
