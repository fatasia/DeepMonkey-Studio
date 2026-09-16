//! P1-23:N1 版本化输入适配器(高价值 SVG 子集 / 富文本 inline / 图表扩展 / 动画 ABI)。
//!
//! ## 这个模块解决什么
//!
//! 四类高价值外部输入各自有一个带版本号的输入 schema(封闭枚举 + 显式版本字段,
//! 见 [`schema`]);适配器把**有 fixture 认证**的输入适配为批量 display delta
//! ([`N1DisplayDelta`],与 TS 侧 `Deep2dDisplayList` 的 resources/commands 同形)
//! 与封闭的行为命令(`BehaviorPayload`)。资源身份与预算归宿主管理:适配器
//! 不持有资源、不做 IO、不读时钟——认证台账、字体/inline 资产、预算、fixture
//! 字节与动画采样时刻全部由宿主注入。
//!
//! ## fail-closed 矩阵(核心验收)
//!
//! | 情形 | 结果 |
//! |---|---|
//! | fixture 缺失(`None` / 空字节) | `Blocked`(missing fixture) |
//! | fixture 不是合法 JSON | `Blocked` |
//! | 未识别的输入 kind / 无判别字段 | `Unknown`(语义未知,绝不猜测) |
//! | schema 版本不在 [`SUPPORTED_INPUT_SCHEMA_VERSIONS`] | `Unknown` |
//! | 载荷不符合其声明 schema | `Blocked` |
//! | (kind, 版本, 平台) 组合不在认证台账 | `Blocked`(not certified) |
//! | fixture 摘要与认证记录不符 | `Blocked`(digest mismatch) |
//! | 预算触界 / 语义非法(SVG 未支持指令、区间越界等) | `Blocked` |
//!
//! 仅当 kind 与版本可识别、组合已认证、摘要匹配、预算与语义全部通过,
//! 才输出 [`N1Outcome::Adapted`];任何失败路径都不产出部分结果。
//!
//! ## 与 P1-22 的呼应
//!
//! 适配产物中的行为命令可直接编入 `replay::ScriptEntry::Command`;动画采样
//! 时刻由调用方注入,与回放器的固定步时钟同一纪律。fixture 摘要复用
//! `shader_package::hash_canonical`(canonical JSON + SHA-256),与回放
//! display hash 同一机制,跨语言可复算。

mod adapt;
mod chart_overlay;
mod schema;
mod svg_parse;
mod validate;

pub use adapt::{N1Adapted, N1DisplayDelta};
pub use schema::{
    ADAPTER_N1_SCHEMA_VERSION, AnimationAbiInputV1, AnimationKeyframeV1, AnimationPropertyV1,
    AnimationTrackV1, AnimationValueV1, ChartExtensionInputV1, ChartOverlayV1, InlineObjectV1,
    N1InputKind, RichTextAlignV1, RichTextInlineInputV1, RichTextParagraphV1, RichTextStyleSpanV1,
    SUPPORTED_INPUT_SCHEMA_VERSIONS, SvgInputV1, SvgPathSpecV1,
};

#[cfg(test)]
#[path = "adapter_n1_golden_tests.rs"]
mod golden_tests;
#[cfg(test)]
#[path = "adapter_n1_test_support.rs"]
mod test_support;
#[cfg(test)]
#[path = "adapter_n1_tests.rs"]
mod tests;

use crate::shader_package::hash::hash_canonical;
use std::collections::{BTreeMap, BTreeSet};

/// 一条认证记录:(输入类别, schema 版本, 平台) → 已复核 fixture 摘要。
/// 「认证」的含义是该组合的 fixture 内容已被人工复核,摘要即其指纹。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct N1Certification {
    pub kind: N1InputKind,
    pub schema_version: u32,
    /// 宿主平台标识(如 `win-dx12` / `web-webgpu`);精确匹配,无通配。
    pub platform: String,
    /// 已复核 fixture 的 canonical-JSON SHA-256(hex)。
    pub fixture_digest: String,
}

/// 宿主注入的认证台账。适配器只读,自己不认证任何组合。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct N1Certifications {
    entries: BTreeSet<N1Certification>,
}

impl N1Certifications {
    pub fn new(entries: impl IntoIterator<Item = N1Certification>) -> Self {
        Self {
            entries: entries.into_iter().collect(),
        }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn lookup(
        &self,
        kind: N1InputKind,
        schema_version: u32,
        platform: &str,
    ) -> Option<&N1Certification> {
        self.entries.iter().find(|entry| {
            entry.kind == kind
                && entry.schema_version == schema_version
                && entry.platform == platform
        })
    }
}

/// 字体资源身份:富文本 text 命令所需的资源字段全部由宿主给足。
#[derive(Debug, Clone, PartialEq)]
pub struct N1FontAsset {
    pub id: String,
    pub asset_id: String,
    pub family: String,
    /// 100..=900,步长 100(与 Deep2d 字体资源合同一致)。
    pub weight: u16,
    pub style: N1FontStyle,
    pub color: [f64; 4],
    pub font_size: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum N1FontStyle {
    Normal,
    Italic,
}

/// inline object 的宿主资产身份:适配器按 `object_id` 精确查找,
/// 查不到即 Blocked,绝不猜测尺寸或资产。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct N1InlineAsset {
    pub asset_id: String,
    /// 像素尺寸,1..=65536(与 Deep2d 图片资源合同一致)。
    pub width: u32,
    pub height: u32,
}

/// 宿主注入的资源身份集合。
#[derive(Debug, Clone, PartialEq)]
pub struct N1HostAssets {
    pub font: N1FontAsset,
    pub inline_assets: BTreeMap<String, N1InlineAsset>,
}

/// 宿主注入的预算:全部硬上限,触界即 Blocked(不截断、不排队、不降级)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct N1Budget {
    pub max_paths: usize,
    pub max_verbs_per_path: usize,
    pub max_commands: usize,
    pub max_text_code_units: usize,
    pub max_animation_tracks: usize,
    pub max_keyframes_per_track: usize,
    /// fixture 字节上限,防超大输入拖死适配。
    pub max_fixture_bytes: usize,
}

impl Default for N1Budget {
    fn default() -> Self {
        Self {
            max_paths: 4_096,
            max_verbs_per_path: 65_536,
            max_commands: 65_536,
            max_text_code_units: 1_000_000,
            max_animation_tracks: 1_024,
            max_keyframes_per_track: 4_096,
            max_fixture_bytes: 4 * 1024 * 1024,
        }
    }
}

/// 适配结果:fail-closed 三态。`Adapted` 之外一律不产出 delta/命令。
#[derive(Debug, Clone, PartialEq)]
pub enum N1Outcome {
    Adapted(N1Adapted),
    /// 输入无法被识别(未知 kind、未知版本):语义未知,绝不猜测。
    Unknown {
        reason: String,
    },
    /// 输入可识别但被明确拒绝(缺 fixture、未认证、摘要不符、超预算、语义非法)。
    Blocked {
        reason: String,
    },
}

impl N1Outcome {
    pub fn adapted(&self) -> Option<&N1Adapted> {
        match self {
            Self::Adapted(adapted) => Some(adapted),
            _ => None,
        }
    }
}

/// N1 适配器。协作对象全部由宿主注入;构造时校验宿主资产的形状,
/// 之后 `adapt` 为纯函数:同一输入恒得同一结果。
#[derive(Debug, Clone)]
pub struct N1Adapter {
    certifications: N1Certifications,
    budget: N1Budget,
    assets: N1HostAssets,
}

impl N1Adapter {
    pub fn new(
        certifications: N1Certifications,
        budget: N1Budget,
        assets: N1HostAssets,
    ) -> Result<Self, String> {
        let font = &assets.font;
        for (value, label) in [
            (font.id.as_str(), "font id"),
            (font.asset_id.as_str(), "font asset id"),
            (font.family.as_str(), "font family"),
        ] {
            if value.trim().is_empty() {
                return Err(format!("host font {label} must be non-blank"));
            }
        }
        if font.weight < 100 || font.weight > 900 || !font.weight.is_multiple_of(100) {
            return Err("host font weight must be 100..900 in steps of 100".into());
        }
        validate::require_id(font.id.as_str(), "host font id")?;
        if !font
            .color
            .iter()
            .all(|ch| ch.is_finite() && (0.0..=1.0).contains(ch))
        {
            return Err("host font color must be four finite channels in [0, 1]".into());
        }
        if !font.font_size.is_finite() || font.font_size <= 0.0 || font.font_size > 65_536.0 {
            return Err("host font size must be finite in (0, 65536]".into());
        }
        for (object_id, asset) in &assets.inline_assets {
            if asset.asset_id.trim().is_empty() {
                return Err(format!("inline asset '{object_id}' has a blank asset id"));
            }
            if asset.width == 0
                || asset.height == 0
                || asset.width > 65_536
                || asset.height > 65_536
            {
                return Err(format!(
                    "inline asset '{object_id}' dimensions must be in 1..=65536"
                ));
            }
        }
        Ok(Self {
            certifications,
            budget,
            assets,
        })
    }

    /// 适配一个 fixture。`fixture` 由宿主从其存储读出后传入(适配器不做 IO);
    /// `elapsed_ms` 是注入时钟,仅动画 ABI 消费;`platform` 精确匹配认证台账。
    pub fn adapt(&self, fixture: Option<&[u8]>, platform: &str, elapsed_ms: u64) -> N1Outcome {
        let Some(bytes) = fixture.filter(|bytes| !bytes.is_empty()) else {
            return N1Outcome::Blocked {
                reason:
                    "missing fixture bytes: certified combinations require the reviewed fixture"
                        .into(),
            };
        };
        if bytes.len() > self.budget.max_fixture_bytes {
            return N1Outcome::Blocked {
                reason: format!(
                    "fixture exceeds the byte budget: {} > max {}",
                    bytes.len(),
                    self.budget.max_fixture_bytes
                ),
            };
        }
        let value: serde_json::Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(error) => {
                return N1Outcome::Blocked {
                    reason: format!("fixture is not valid JSON: {error}"),
                };
            }
        };
        let (kind, schema_version) = match classify(&value) {
            Ok(found) => found,
            Err(outcome) => return outcome,
        };
        let Some(certification) = self.certifications.lookup(kind, schema_version, platform) else {
            return N1Outcome::Blocked {
                reason: format!(
                    "platform combination ('{}', schema v{schema_version}, platform '{platform}') is not certified",
                    kind.as_str()
                ),
            };
        };
        let digest = hash_canonical(&value);
        if digest != certification.fixture_digest {
            return N1Outcome::Blocked {
                reason: format!(
                    "fixture digest mismatch: certified {}, got {digest}",
                    certification.fixture_digest
                ),
            };
        }
        // 摘要匹配的 fixture 理论上必然符合其声明 schema;这里仍按防御性
        // 复核解析(载荷层 fail-closed),失败即 Blocked,绝不带病适配。
        let Some(input) = value.get("input") else {
            return N1Outcome::Blocked {
                reason: "fixture has no 'input' payload".into(),
            };
        };
        let conformance = |error: serde_json::Error| {
            format!("input does not conform to its declared schema: {error}")
        };
        let adapted = match kind {
            N1InputKind::Svg => serde_json::from_value::<SvgInputV1>(input.clone())
                .map_err(conformance)
                .and_then(|input| adapt::adapt_svg(&input, &self.budget)),
            N1InputKind::RichTextInline => {
                serde_json::from_value::<RichTextInlineInputV1>(input.clone())
                    .map_err(conformance)
                    .and_then(|input| adapt::adapt_rich_text(&input, &self.budget, &self.assets))
            }
            N1InputKind::ChartExtension => {
                serde_json::from_value::<ChartExtensionInputV1>(input.clone())
                    .map_err(conformance)
                    .and_then(|input| chart_overlay::adapt_chart_extension(&input, &self.budget))
            }
            N1InputKind::AnimationAbi => {
                serde_json::from_value::<AnimationAbiInputV1>(input.clone())
                    .map_err(conformance)
                    .and_then(|input| adapt::adapt_animation(&input, elapsed_ms, &self.budget))
            }
        };
        match adapted {
            Ok(adapted) => N1Outcome::Adapted(adapted),
            Err(reason) => N1Outcome::Blocked { reason },
        }
    }
}

/// 从原始 JSON 里先读判别字段,把「未知 kind / 未知版本」(`Unknown`)
/// 与「载荷不符」(`Blocked`)区分开——两边的处置纪律不同。
fn classify(value: &serde_json::Value) -> Result<(N1InputKind, u32), N1Outcome> {
    let unknown = |reason: String| N1Outcome::Unknown { reason };
    let kind_str = value
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| unknown("fixture has no 'kind' discriminator".into()))?;
    let kind = N1InputKind::ALL
        .iter()
        .copied()
        .find(|kind| kind.as_str() == kind_str)
        .ok_or_else(|| {
            unknown(format!(
                "unknown input kind '{kind_str}' (known kinds: {})",
                N1InputKind::ALL
                    .iter()
                    .map(|kind| kind.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?;
    let version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| unknown("fixture has no numeric 'schemaVersion'".into()))?;
    let version = u32::try_from(version)
        .map_err(|_| unknown(format!("schema version {version} is out of range")))?;
    if !SUPPORTED_INPUT_SCHEMA_VERSIONS.contains(&version) {
        return Err(unknown(format!(
            "unsupported schema version {version} for kind '{}'",
            kind.as_str()
        )));
    }
    Ok((kind, version))
}

/// 供测试与宿主侧预检复算 fixture 摘要(与认证台账同一机制)。
pub fn fixture_digest(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    Some(hash_canonical(&value))
}
