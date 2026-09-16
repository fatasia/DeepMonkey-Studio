/// 本合同的版本号;结构变化时递增,消费方按此拒绝未知版本。
pub const TEXT_DOCUMENT_SCHEMA_VERSION: u32 = 1;

/// 一个样式区间:`[start_cluster, end_cluster)` 内的簇使用 `style`。
/// 半开区间,相邻区间必须首尾相接或留空,不允许重叠。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StyleSpan {
    pub start_cluster: usize,
    pub end_cluster: usize,
    pub style: TextStyleId,
}

/// 样式标识:文档内自有的小整数,由样式表解析成具体属性。
/// 用标识而非内联属性,使「改一处样式定义」不影响区间本身,也让跨语言比对稳定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TextStyleId(pub u16);

/// 一条段落:由簇区间界定,携带段落级对齐与方向意图(不执行 bidi,只记录意图)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Paragraph {
    pub start_cluster: usize,
    pub end_cluster: usize,
    pub align: ParagraphAlign,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParagraphAlign {
    Start,
    Center,
    End,
    Justify,
}

/// inline object(图片/图标/公式等)占位:它占据一个**簇位置**,
/// 使文本索引与渲染顺序一致;实际像素由上层按 `object_id` 解析。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineObject {
    /// 插入在哪个簇之前;等于簇总数表示追加在末尾。
    pub at_cluster: usize,
    pub object_id: String,
}

/// 一次修改的描述:只报告真正变化的簇区间与版本迁移。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextChange {
    pub previous_revision: u64,
    pub revision: u64,
    /// 变化覆盖的簇区间 `[start, end)`;纯样式修改也走这里。
    pub start_cluster: usize,
    pub end_cluster: usize,
    /// 旧文档受影响范围的右端；删除时也能清理旧字形。
    pub previous_end_cluster: usize,
    /// 簇总数是否变化(插入/删除为真,纯样式修改为假)。
    pub cluster_count_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextDocumentError {
    /// 未知 schema 版本;消费方必须拒绝而不是猜测。
    UnsupportedSchemaVersion {
        found: u32,
    },
    RevisionExhausted,
    /// 样式区间越界、乱序或重叠。
    InvalidStyleSpan {
        index: usize,
        detail: String,
    },
    /// 段落越界、乱序或重叠。
    InvalidParagraph {
        index: usize,
        detail: String,
    },
    /// inline object 位置越界,或同一位置重复插入。
    InvalidInlineObject {
        index: usize,
        detail: String,
    },
    /// 区间边界没有落在字素簇边界上。
    SpanNotOnClusterBoundary {
        cluster: usize,
    },
}

impl std::fmt::Display for TextDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RevisionExhausted => write!(f, "text revision exhausted"),
            Self::UnsupportedSchemaVersion { found } => {
                write!(f, "unsupported text document schema version {found}")
            }
            Self::InvalidStyleSpan { index, detail } => {
                write!(f, "style span {index} invalid: {detail}")
            }
            Self::InvalidParagraph { index, detail } => {
                write!(f, "paragraph {index} invalid: {detail}")
            }
            Self::InvalidInlineObject { index, detail } => {
                write!(f, "inline object {index} invalid: {detail}")
            }
            Self::SpanNotOnClusterBoundary { cluster } => {
                write!(
                    f,
                    "span boundary {cluster} is not a grapheme cluster boundary"
                )
            }
        }
    }
}

impl std::error::Error for TextDocumentError {}
