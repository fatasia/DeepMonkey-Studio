//! P1-19 基础:字体身份冻结与能力矩阵。
//!
//! 解决的真问题:`TextRasterizer::new()` 走 `FontSystem::new()` 从**操作系统已安装字体**
//! 加载,同一段文字在不同机器上会用不同字体渲染,而产物里没有任何记录。
//! 本模块把字体从「运行时恰好装了什么」变成**可冻结、可审计的身份**:
//!
//! - `FontFaceIdentity`:家族/PostScript 名/字重/样式/等宽标志 + **字体数据 hash**
//!   (通过 `with_face_data` 取原始字节)。hash 是跨机器比对「是不是同一个字体」的唯一
//!   可信依据——家族名相同不代表文件相同(同名不同版本、不同厂商很常见)。
//! - `FontCapabilityReport`:逐面记录**来源**(系统文件/内嵌)、许可声明状态与覆盖范围,
//!   使「缺字」「不可再分发」能给出**对象级**诊断,而不是渲染出来一片空白。
//!
//! 边界(刻意):本模块**不下载、不内嵌字体**,也不改许可证。它只做「测量与声明」:
//! 当前事实是系统字体,因此 `embedded=false`、`license=Unknown`,上层必须据此
//! 把字体相关能力标为 degraded,而不是假装已打包。真正内嵌字体(含许可与子集化)
//! 是独立决策,需要用户对再分发权的确认。
//!
//! 确定性:同一个字体文件在任何机器上得到同一个 hash;报告按 hash 稳定排序,
//! 使跨机器比对是逐字节可复算的,而不是依赖 `faces()` 的枚举顺序。

use std::collections::BTreeMap;
use std::hash::Hasher;

use cosmic_text::{FontSystem, Weight};

/// 字体能力矩阵的 schema 版本。
pub const FONT_CAPABILITY_SCHEMA_VERSION: u32 = 1;

/// 字体来源类别。位置(路径)不进入身份——同一字体在不同机器路径不同,
/// 但 hash 相同即同一字体;路径只作为诊断线索。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FontSourceKind {
    /// 操作系统已安装字体(当前唯一实际来源)。
    SystemInstalled,
    /// 随产物内嵌(尚未实现;引入必须先解决许可与子集化)。
    Embedded,
}

/// 许可声明状态。**未知不等于可分发**——上层必须按最保守处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LicenseStatus {
    /// 未声明。系统字体通常属此类:能本机使用,但再分发权未确认。
    Unknown,
    /// 已确认可随产物再分发。
    Redistributable,
    /// 明确不可再分发(例如某些 OEM 随机器授权字体)。
    NotRedistributable,
}

/// 一个字体面的冻结身份。同 `content_hash` 即同一字体,与机器和路径无关。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontFaceIdentity {
    /// 主家族名(英文名优先);缺失时为空串,调用方须容忍。
    pub family: String,
    pub post_script_name: String,
    /// 字重(100..900 的 OpenType 数值)。
    pub weight: u16,
    pub italic: bool,
    pub monospaced: bool,
    pub source_kind: FontSourceKind,
    /// 字体数据 FNV-1a 64 位 hash。跨机器可复算,用于判定「是否同一字体文件」。
    pub content_hash: u64,
    /// 字体数据字节数(与 hash 一起构成强区分)。
    pub content_bytes: usize,
}

/// 单面的能力条目:身份 + 许可 + 该面在实际使用中的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontFaceCapability {
    pub identity: FontFaceIdentity,
    pub license: LicenseStatus,
    /// 该面是否可用于当前产物。系统字体且许可未知时为 `false`——
    /// 这是刻意的保守默认:能渲染不代表可交付。
    pub usable_in_artifact: bool,
}

/// 字体能力矩阵:按 hash 稳定排序的全部面 + 统计。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontCapabilityReport {
    pub schema_version: u32,
    pub faces: Vec<FontFaceCapability>,
    /// 各来源类别的面数。
    pub source_counts: BTreeMap<&'static str, usize>,
    /// 可用于产物的面数。
    pub usable_faces: usize,
}

impl FontCapabilityReport {
    /// 按家族名查找可用于产物的面;返回空表示该家族在产物中不可用。
    pub fn usable_families(&self) -> Vec<&str> {
        let mut families = self
            .faces
            .iter()
            .filter(|face| face.usable_in_artifact)
            .map(|face| face.identity.family.as_str())
            .collect::<Vec<_>>();
        families.sort_unstable();
        families.dedup();
        families
    }

    /// 某个家族是否**只**有不可用的面(用于给出对象级诊断)。
    pub fn family_blocked_reason(&self, family: &str) -> Option<&'static str> {
        let matching = self
            .faces
            .iter()
            .filter(|face| face.identity.family == family)
            .collect::<Vec<_>>();
        if matching.is_empty() {
            return Some("font family not present on this machine");
        }
        if matching.iter().all(|face| !face.usable_in_artifact) {
            return Some(match matching[0].license {
                LicenseStatus::Unknown => {
                    "font is installed but its redistribution license is unknown"
                }
                LicenseStatus::NotRedistributable => "font license forbids redistribution",
                LicenseStatus::Redistributable => "font is not embedded in the artifact",
            });
        }
        None
    }

    /// 人类可读的一行摘要(启动报告用)。
    pub fn summary(&self) -> String {
        let system = self
            .source_counts
            .get("system-installed")
            .copied()
            .unwrap_or(0);
        let embedded = self.source_counts.get("embedded").copied().unwrap_or(0);
        format!(
            "faces={} system={} embedded={} usable={}",
            self.faces.len(),
            system,
            embedded,
            self.usable_faces
        )
    }
}

/// 从 `FontSystem` 探测全部字体面并生成能力矩阵。
///
/// 这是唯一读取系统字体的入口;结果按 `content_hash` 稳定排序,汇总可复算。
pub fn capability_report(fonts: &mut FontSystem) -> FontCapabilityReport {
    let database = fonts.db_mut();
    let mut faces = Vec::new();
    for info in database.faces() {
        // 字体数据 hash:跨机器比对「是否同一字体文件」的唯一可信依据。
        let Some((hash, bytes)) = database.with_face_data(info.id, |data, _index| {
            let mut hasher = FnvHasher::default();
            hasher.write(data);
            (hasher.finish(), data.len())
        }) else {
            // 拿不到数据就不产出身份——宁缺勿造,避免出现「hash=0」这种伪身份。
            continue;
        };
        let family = info
            .families
            .first()
            .map(|(name, _)| name.clone())
            .unwrap_or_default();
        faces.push(FontFaceCapability {
            identity: FontFaceIdentity {
                family,
                post_script_name: info.post_script_name.clone(),
                weight: weight_value(info.weight),
                italic: matches!(
                    info.style,
                    cosmic_text::Style::Italic | cosmic_text::Style::Oblique
                ),
                monospaced: info.monospaced,
                source_kind: FontSourceKind::SystemInstalled,
                content_hash: hash,
                content_bytes: bytes,
            },
            license: LicenseStatus::Unknown,
            // 系统字体在本机可渲染,但**未经许可确认不得计入可交付产物**。
            usable_in_artifact: false,
        });
    }
    // 稳定排序:hash 优先,再按 PostScript 名,使结果与枚举顺序无关。
    faces.sort_by(|a, b| {
        a.identity.content_hash.cmp(&b.identity.content_hash).then(
            a.identity
                .post_script_name
                .cmp(&b.identity.post_script_name),
        )
    });
    faces.dedup_by(|a, b| a.identity.content_hash == b.identity.content_hash);

    let mut source_counts = BTreeMap::new();
    for face in &faces {
        let key = match face.identity.source_kind {
            FontSourceKind::SystemInstalled => "system-installed",
            FontSourceKind::Embedded => "embedded",
        };
        *source_counts.entry(key).or_insert(0) += 1;
    }
    let usable_faces = faces.iter().filter(|face| face.usable_in_artifact).count();
    FontCapabilityReport {
        schema_version: FONT_CAPABILITY_SCHEMA_VERSION,
        faces,
        source_counts,
        usable_faces,
    }
}

/// fontdb 0.23 的字重已是数值结构体 `Weight(pub u16)`,直接取用;
/// 仅做保守截断,不猜非标准值的语义。
fn weight_value(weight: Weight) -> u16 {
    weight.0.clamp(1, 1000)
}

/// FNV-1a 64 位:跨机器、跨进程稳定,且不依赖 HashMap 的随机种子
/// (`DefaultHasher` 跨进程不保证稳定,不能用于冻结身份)。
#[derive(Default)]
struct FnvHasher(u64);

impl Hasher for FnvHasher {
    fn finish(&self) -> u64 {
        if self.0 == 0 {
            // 空数据也返回固定常量,避免 0 与「未初始化」混淆。
            0xcbf2_9ce4_8422_2325
        } else {
            self.0
        }
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut hash = if self.0 == 0 {
            0xcbf2_9ce4_8422_2325u64
        } else {
            self.0
        };
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        self.0 = hash;
    }
}

/// 探针:给定家族是否**存在于本机字体库**。
///
/// 口径说明(实测确立):不能用 cosmic-text 的成形结果判断「指定家族是否覆盖」——
/// 整形器在家族缺失时会**静默 fallback** 到别的字体,于是不存在的家族照样成形成功,
/// 探针会恒返回 true 而失去意义。因此这里直接查字体库的面是否存在,
/// 并用 `family_covers_text` 单独判断「成形是否产生了 .notdef」。
pub fn family_exists(fonts: &mut FontSystem, family: &str) -> bool {
    if family.is_empty() || family.len() > 256 {
        return false;
    }
    fonts
        .db_mut()
        .faces()
        .any(|info| info.families.iter().any(|(name, _)| name == family))
}

/// 探针:整形给定文本时是否出现 `.notdef`(缺字诊断的对象级入口)。
///
/// 注意语义:**这不能证明指定家族覆盖**,因为整形器会 fallback 到其他已装字体;
/// 它回答的是「按当前系统整体字体能力,这段文字能否成形而不出现缺字方框」。
/// 需要「指定家族是否可用」时用 `family_exists`。
pub fn text_shapes_without_missing_glyphs(
    fonts: &mut FontSystem,
    family: &str,
    text: &str,
) -> bool {
    if family.len() > 256 || text.len() > 16_384 {
        return false;
    }
    let metrics = cosmic_text::Metrics::new(16.0, 20.0);
    let mut buffer = cosmic_text::Buffer::new(fonts, metrics);
    let attrs = cosmic_text::Attrs::new().family(if family.is_empty() {
        cosmic_text::Family::SansSerif
    } else {
        cosmic_text::Family::Name(family)
    });
    buffer.set_text(text, &attrs, cosmic_text::Shaping::Advanced, None);
    buffer.shape_until_scroll(fonts, false);
    // 任一布局字形是 .notdef 即视为缺字;空白字符不参与判定——整形器可能不给空格
    // 分配真实字形,把它算作缺字会制造假阳性。
    buffer.layout_runs().all(|run| {
        run.glyphs.iter().all(|glyph| {
            glyph.glyph_id != 0
                || text[glyph.start..glyph.end]
                    .chars()
                    .all(char::is_whitespace)
        })
    })
}

#[cfg(test)]
#[path = "font_capability_tests.rs"]
mod tests;
