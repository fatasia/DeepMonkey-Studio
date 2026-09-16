//! P1-18 基础:版本化文本 IR(`TextDocumentV1`)。
//!
//! 目标是把散落的字素簇(`layout`)、编辑态(`text_edit`)、组合态(`ime`)收成一份
//! **TS/Rust 共同解释、可局部失效**的稳定表示:文本 + 样式区间 + 段落 + inline object。
//!
//! 设计约束(逐条对应任务表的完成条件):
//!
//! - **簇边界优先**:样式区间与 inline object 的位置一律以**字素簇索引**表达,
//!   不用字节偏移。字节偏移会在组合字符/emoji/ZWJ 序列中间切开,产生非法簇;
//!   簇索引跨语言可复算(`layout::grapheme_clusters` 是同一套规则)。
//! - **区间不重叠、按序**:样式区间排序且互不重叠,查询是二分的。
//!   区间只描述「哪些簇用什么样式」,不携带字体身份——字体身份归 P1-19,
//!   本模块刻意不猜字体,缺字体时必须由上层给对象级诊断。
//! - **局部失效**:每次修改产出 `TextChange`,只描述真正变化的簇区间与前后的
//!   版本号;上层据此只失效受影响的 atlas/glyph run,而不是整段重建。
//! - **版本化**:`revision` 单调递增,任何修改(含样式与 inline object)都推进它。
//!   消费方按 revision 判定缓存是否仍然有效。
//!
//! 明确不在本模块:字体选择与回退(P1-19)、真实 IME 事务(P1-20)、
//! bidi 重排(需要已批准的 shaping 库)。

use super::layout::grapheme_clusters;

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
    /// 簇总数是否变化(插入/删除为真,纯样式修改为假)。
    pub cluster_count_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextDocumentError {
    /// 未知 schema 版本;消费方必须拒绝而不是猜测。
    UnsupportedSchemaVersion { found: u32 },
    /// 样式区间越界、乱序或重叠。
    InvalidStyleSpan { index: usize, detail: String },
    /// 段落越界、乱序或重叠。
    InvalidParagraph { index: usize, detail: String },
    /// inline object 位置越界,或同一位置重复插入。
    InvalidInlineObject { index: usize, detail: String },
    /// 区间边界没有落在字素簇边界上。
    SpanNotOnClusterBoundary { cluster: usize },
}

impl std::fmt::Display for TextDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
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
                write!(f, "span boundary {cluster} is not a grapheme cluster boundary")
            }
        }
    }
}

impl std::error::Error for TextDocumentError {}

/// 版本化文本文档。`text` 是唯一真源,所有区间都是它的簇索引投影。
#[derive(Debug, Clone, PartialEq)]
pub struct TextDocumentV1 {
    schema_version: u32,
    revision: u64,
    text: String,
    /// 缓存的簇边界(字节偏移)。文本变化时重算;查询样式/段落直接复用。
    cluster_bounds: Vec<usize>,
    styles: Vec<StyleSpan>,
    paragraphs: Vec<Paragraph>,
    inline_objects: Vec<InlineObject>,
}

impl TextDocumentV1 {
    /// 从文本与已解析的区间构造并校验。空文档合法(0 簇)。
    pub fn new(
        text: impl Into<String>,
        styles: Vec<StyleSpan>,
        paragraphs: Vec<Paragraph>,
        inline_objects: Vec<InlineObject>,
    ) -> Result<Self, TextDocumentError> {
        let text = text.into();
        let cluster_bounds = cluster_bounds(&text);
        let cluster_count = cluster_bounds.len().saturating_sub(1);
        validate_styles(&styles, cluster_count)?;
        let paragraphs = normalize_paragraphs(paragraphs, cluster_count)?;
        validate_inline_objects(&inline_objects, cluster_count)?;
        Ok(Self {
            schema_version: TEXT_DOCUMENT_SCHEMA_VERSION,
            revision: 1,
            text,
            cluster_bounds,
            styles,
            paragraphs,
            inline_objects,
        })
    }

    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    /// 字素簇总数。光标/选区/区间的合法上界(含端点)。
    pub fn cluster_count(&self) -> usize {
        self.cluster_bounds.len().saturating_sub(1)
    }
    pub fn styles(&self) -> &[StyleSpan] {
        &self.styles
    }
    pub fn paragraphs(&self) -> &[Paragraph] {
        &self.paragraphs
    }
    pub fn inline_objects(&self) -> &[InlineObject] {
        &self.inline_objects
    }

    /// 第 `index` 个簇的字节范围。越界返回 `None`(调用方据此拒绝)。
    pub fn cluster_bytes(&self, index: usize) -> Option<(usize, usize)> {
        let start = *self.cluster_bounds.get(index)?;
        let end = *self.cluster_bounds.get(index + 1)?;
        Some((start, end))
    }

    /// 第 `index` 个簇的文本切片。
    pub fn cluster_text(&self, index: usize) -> Option<&str> {
        let (start, end) = self.cluster_bytes(index)?;
        Some(&self.text[start..end])
    }

    /// 某簇生效的样式:区间不重叠,二分定位。未覆盖的簇返回 `None`
    /// (上层据此决定是否用文档默认样式,本模块不发明默认值)。
    pub fn style_at(&self, cluster: usize) -> Option<TextStyleId> {
        if cluster >= self.cluster_count() {
            return None;
        }
        let index = self
            .styles
            .partition_point(|span| span.start_cluster <= cluster);
        let span = self.styles.get(index.checked_sub(1)?)?;
        (cluster < span.end_cluster).then_some(span.style)
    }

    /// 某簇所属段落;同理二分。
    pub fn paragraph_at(&self, cluster: usize) -> Option<&Paragraph> {
        if cluster >= self.cluster_count() {
            return None;
        }
        let index = self
            .paragraphs
            .partition_point(|p| p.start_cluster <= cluster);
        let paragraph = self.paragraphs.get(index.checked_sub(1)?)?;
        (cluster < paragraph.end_cluster).then_some(paragraph)
    }

    /// 覆盖 `[start, end)` 的样式区间(可能多条,按序);用于局部重绘。
    pub fn styles_in(&self, start: usize, end: usize) -> &[StyleSpan] {
        if start >= end {
            return &[];
        }
        let first = self.styles.partition_point(|span| span.end_cluster <= start);
        let last = self
            .styles
            .partition_point(|span| span.start_cluster < end);
        &self.styles[first..last]
    }

    /// inline object 在 `[start, end)` 内的部分。
    pub fn inline_objects_in(&self, start: usize, end: usize) -> &[InlineObject] {
        if start >= end {
            return &[];
        }
        let first = self
            .inline_objects
            .partition_point(|object| object.at_cluster < start);
        let last = self
            .inline_objects
            .partition_point(|object| object.at_cluster < end);
        &self.inline_objects[first..last]
    }

    /// 按簇区间替换文本(编辑/IME 提交的落地点)。样式与 inline object 随簇数
    /// 平移:区间在编辑点之后的部分按簇数差整体迁移,跨越编辑点的区间收缩/扩张到
    /// 编辑点。返回 `TextChange` 供上层局部失效。
    ///
    /// 边界语义:`cluster_bounds` 由替换后的文本重算,因此编辑点必须落在簇边界上,
    /// 否则拒绝——避免把组合序列切成两半。
    pub fn replace_clusters(
        &mut self,
        start_cluster: usize,
        end_cluster: usize,
        replacement: &str,
    ) -> Result<TextChange, TextDocumentError> {
        if start_cluster > end_cluster || end_cluster > self.cluster_count() {
            return Err(TextDocumentError::InvalidStyleSpan {
                index: start_cluster,
                detail: format!("replace range {start_cluster}..{end_cluster} out of bounds"),
            });
        }
        let (start_byte, end_byte) = (
            self.cluster_bounds[start_cluster],
            self.cluster_bounds[end_cluster],
        );
        let mut text = String::with_capacity(self.text.len() - (end_byte - start_byte) + replacement.len());
        text.push_str(&self.text[..start_byte]);
        text.push_str(replacement);
        text.push_str(&self.text[end_byte..]);

        let new_bounds = cluster_bounds(&text);
        let new_count = new_bounds.len().saturating_sub(1);
        // 换入文本的簇数决定后续区间的平移量。
        let inserted_clusters =
            cluster_bounds(replacement).len().saturating_sub(1);
        let removed_clusters = end_cluster - start_cluster;
        let delta = inserted_clusters as isize - removed_clusters as isize;

        self.text = text;
        self.cluster_bounds = new_bounds;
        shift_spans(&mut self.styles, start_cluster, end_cluster, inserted_clusters, delta);
        shift_paragraphs(
            &mut self.paragraphs,
            start_cluster,
            end_cluster,
            inserted_clusters,
            delta,
            new_count,
        );
        shift_inline_objects(
            &mut self.inline_objects,
            start_cluster,
            end_cluster,
            inserted_clusters,
            delta,
            new_count,
        );
        self.revision = self.revision.saturating_add(1);
        Ok(TextChange {
            previous_revision: self.revision - 1,
            revision: self.revision,
            start_cluster,
            end_cluster: start_cluster + inserted_clusters,
            cluster_count_changed: delta != 0,
        })
    }

    /// 整体替换样式表。文本不变,只推进 revision 并报告覆盖区间。
    pub fn set_styles(&mut self, styles: Vec<StyleSpan>) -> Result<TextChange, TextDocumentError> {
        validate_styles(&styles, self.cluster_count())?;
        let (start, end) = style_extent(&self.styles, &styles);
        self.styles = styles;
        self.revision = self.revision.saturating_add(1);
        Ok(TextChange {
            previous_revision: self.revision - 1,
            revision: self.revision,
            start_cluster: start,
            end_cluster: end,
            cluster_count_changed: false,
        })
    }
}

/// 文本的簇边界:字节偏移序列,长度恒为簇数 + 1,首元素 0、末元素 len。
fn cluster_bounds(text: &str) -> Vec<usize> {
    let mut bounds = vec![0usize];
    for cluster in grapheme_clusters(text, |_| 0.0) {
        bounds.push(cluster.end);
    }
    if bounds.len() == 1 {
        // 空文本:只有起点,没有簇。
        bounds[0] = 0;
    }
    bounds
}

fn validate_styles(
    styles: &[StyleSpan],
    cluster_count: usize,
) -> Result<(), TextDocumentError> {
    let mut previous_end = 0usize;
    for (index, span) in styles.iter().enumerate() {
        if span.start_cluster >= span.end_cluster {
            return Err(TextDocumentError::InvalidStyleSpan {
                index,
                detail: "start must be strictly before end".into(),
            });
        }
        if span.end_cluster > cluster_count {
            return Err(TextDocumentError::InvalidStyleSpan {
                index,
                detail: format!(
                    "end {} exceeds cluster count {cluster_count}",
                    span.end_cluster
                ),
            });
        }
        if span.start_cluster < previous_end {
            return Err(TextDocumentError::InvalidStyleSpan {
                index,
                detail: "spans must be sorted and non-overlapping".into(),
            });
        }
        previous_end = span.end_cluster;
    }
    Ok(())
}

/// 段落缺省时铺一条覆盖全文的 Start 段落。
///
/// 校验与补全的语义分工:
/// - **重叠/乱序/越界**是调用方错误 → 拒绝(不静默修正,否则宿主无从发现自己传错);
/// - **空洞**是允许的输入形态(作者只标了部分段落)→ 补全到「每簇必属某段」。
///
/// 这条不变量必须在**构造期与编辑期都**成立:只在编辑期维护会让构造出的文档
/// 从一开始就带着 `paragraph_at` 返回 `None` 的簇。
fn normalize_paragraphs(
    mut paragraphs: Vec<Paragraph>,
    cluster_count: usize,
) -> Result<Vec<Paragraph>, TextDocumentError> {
    let mut previous_end = 0usize;
    for (index, paragraph) in paragraphs.iter().enumerate() {
        if paragraph.start_cluster >= paragraph.end_cluster {
            return Err(TextDocumentError::InvalidParagraph {
                index,
                detail: "start must be strictly before end".into(),
            });
        }
        if paragraph.end_cluster > cluster_count {
            return Err(TextDocumentError::InvalidParagraph {
                index,
                detail: format!(
                    "end {} exceeds cluster count {cluster_count}",
                    paragraph.end_cluster
                ),
            });
        }
        if paragraph.start_cluster < previous_end {
            return Err(TextDocumentError::InvalidParagraph {
                index,
                detail: "paragraphs must be sorted and non-overlapping".into(),
            });
        }
        previous_end = paragraph.end_cluster;
    }
    paragraphs.sort_by_key(|paragraph| paragraph.start_cluster);
    fill_paragraph_gaps(&mut paragraphs, cluster_count);
    Ok(paragraphs)
}

/// 把段落列表补成恰好覆盖 `[0, cluster_count)`(空文档保留一条空段落)。
/// 空洞处沿用**前一段**的对齐,首部空洞沿用后一段——使补全不引入新语义。
fn fill_paragraph_gaps(paragraphs: &mut Vec<Paragraph>, cluster_count: usize) {
    if paragraphs.is_empty() {
        paragraphs.push(Paragraph {
            start_cluster: 0,
            end_cluster: cluster_count,
            align: ParagraphAlign::Start,
        });
        return;
    }
    // 首部空洞。
    if paragraphs[0].start_cluster > 0 {
        let first = paragraphs[0];
        paragraphs.insert(
            0,
            Paragraph {
                start_cluster: 0,
                end_cluster: first.start_cluster,
                align: first.align,
            },
        );
    }
    // 中段与尾部空洞:逐条填补到下一个段落的起点,最后补到结尾。
    let mut index = 1;
    while index < paragraphs.len() {
        let gap_start = paragraphs[index - 1].end_cluster;
        let next_start = paragraphs[index].start_cluster;
        if gap_start < next_start {
            let align = paragraphs[index - 1].align;
            paragraphs.insert(
                index,
                Paragraph {
                    start_cluster: gap_start,
                    end_cluster: next_start,
                    align,
                },
            );
            index += 1;
        }
        index += 1;
    }
    if let Some(last) = paragraphs.last().copied()
        && last.end_cluster < cluster_count
    {
        paragraphs.push(Paragraph {
            start_cluster: last.end_cluster,
            end_cluster: cluster_count,
            align: last.align,
        });
    }
    // 空文档且无段落时补一条空段落(intersected 后可能为空)。
    if paragraphs.is_empty() {
        paragraphs.push(Paragraph {
            start_cluster: 0,
            end_cluster: cluster_count,
            align: ParagraphAlign::Start,
        });
    }
}

fn validate_inline_objects(
    objects: &[InlineObject],
    cluster_count: usize,
) -> Result<(), TextDocumentError> {
    let mut previous: Option<usize> = None;
    for (index, object) in objects.iter().enumerate() {
        if object.at_cluster > cluster_count {
            return Err(TextDocumentError::InvalidInlineObject {
                index,
                detail: format!(
                    "position {} exceeds cluster count {cluster_count}",
                    object.at_cluster
                ),
            });
        }
        if previous.is_some_and(|position| object.at_cluster <= position) {
            return Err(TextDocumentError::InvalidInlineObject {
                index,
                detail: "objects must be sorted and unique per position".into(),
            });
        }
        if object.object_id.is_empty() {
            return Err(TextDocumentError::InvalidInlineObject {
                index,
                detail: "object id must not be empty".into(),
            });
        }
        previous = Some(object.at_cluster);
    }
    Ok(())
}

/// 编辑后平移样式区间。
///
/// 做法是把每个区间端点按编辑映射到新坐标,再用一条明确的归属规则决定
/// 端点落在编辑点上时向哪边延伸——比逐个列举交叉情形更不容易出错:
///
/// - `start` 端点:若原位置在编辑点**之前或之上**(`<= start`),留在原位;
///   否则映射到 `原位置 + delta`。原位置掉在删除段内(`start < p < end`)时收到编辑点。
/// - `end` 端点:若原位置在编辑点**之后或之上**(`>= end`),映射到 `原位置 + delta`;
///   若掉在删除段内,收到「插入内容之后」(`insert_end`);若恰等于编辑点,
///   则延伸覆盖插入内容(插入文本继承左侧样式)。
///
/// 这条规则同时覆盖纯插入(`start == end`)与真删除,无需分支区分。
fn shift_spans(
    spans: &mut Vec<StyleSpan>,
    start: usize,
    end: usize,
    inserted: usize,
    delta: isize,
) {
    let insert_end = start + inserted;
    let shift = |value: usize| -> usize { (value as isize + delta).max(0) as usize };
    let mut shifted = Vec::with_capacity(spans.len());
    for span in spans.iter() {
        let map_start = |value: usize| -> usize {
            if value <= start {
                value
            } else if value >= end {
                shift(value)
            } else {
                start
            }
        };
        let map_end = |value: usize| -> usize {
            if value == start {
                // 右端恰在编辑点:延伸覆盖插入内容,使插入文本继承左侧样式。
                insert_end
            } else if value < end {
                insert_end
            } else {
                shift(value)
            }
        };
        let next = StyleSpan {
            start_cluster: map_start(span.start_cluster),
            end_cluster: map_end(span.end_cluster),
            style: span.style,
        };
        if next.start_cluster < next.end_cluster {
            shifted.push(next);
        }
    }
    // 端点独立映射必然会产生重叠(例如删除段同时切到两条相邻区间时,两条都可能
    // 延伸到同一编辑点)。这里做一次规范化:排序,然后逐条把左端推到上一条右端,
    // 保证「排序且不重叠」的不变量恒成立——重叠会让 `style_at` 的二分给出矛盾答案。
    shifted.sort_by(|a, b| {
        a.start_cluster
            .cmp(&b.start_cluster)
            .then(a.end_cluster.cmp(&b.end_cluster))
    });
    let mut normalized: Vec<StyleSpan> = Vec::with_capacity(shifted.len());
    for span in shifted {
        let start = span
            .start_cluster
            .max(normalized.last().map_or(0, |previous| previous.end_cluster));
        if start < span.end_cluster {
            normalized.push(StyleSpan {
                start_cluster: start,
                end_cluster: span.end_cluster,
                style: span.style,
            });
        }
    }
    *spans = normalized;
}

fn shift_paragraphs(
    paragraphs: &mut Vec<Paragraph>,
    start: usize,
    end: usize,
    inserted: usize,
    delta: isize,
    new_count: usize,
) {
    let insert_end = start + inserted;
    let shift = |value: usize| -> usize { (value as isize + delta).max(0) as usize };
    let mut shifted = Vec::with_capacity(paragraphs.len());
    for paragraph in paragraphs.iter() {
        let mut next = if paragraph.end_cluster <= start {
            *paragraph
        } else if paragraph.start_cluster >= end {
            Paragraph {
                start_cluster: shift(paragraph.start_cluster),
                end_cluster: shift(paragraph.end_cluster),
                align: paragraph.align,
            }
        } else if paragraph.start_cluster < start && paragraph.end_cluster > end {
            // 编辑点落在段落内部:段落整体保留并按 delta 调整末端。
            Paragraph {
                start_cluster: paragraph.start_cluster,
                end_cluster: shift(paragraph.end_cluster),
                align: paragraph.align,
            }
        } else if paragraph.start_cluster < start {
            Paragraph {
                start_cluster: paragraph.start_cluster,
                end_cluster: insert_end,
                align: paragraph.align,
            }
        } else {
            Paragraph {
                start_cluster: start,
                end_cluster: shift(paragraph.end_cluster),
                align: paragraph.align,
            }
        };
        next.start_cluster = next.start_cluster.min(new_count);
        next.end_cluster = next.end_cluster.min(new_count);
        if next.start_cluster < next.end_cluster {
            shifted.push(next);
        }
    }
    // 与样式同理:端点独立映射会产生重叠与空洞。规范化 = 排序 → 去掉重叠 →
    // 复用构造期的 `fill_paragraph_gaps` 补全覆盖,保证两期同一条不变量。
    shifted.sort_by(|a, b| {
        a.start_cluster
            .cmp(&b.start_cluster)
            .then(a.end_cluster.cmp(&b.end_cluster))
    });
    let mut normalized: Vec<Paragraph> = Vec::with_capacity(shifted.len());
    for paragraph in shifted {
        let start = paragraph
            .start_cluster
            .max(normalized.last().map_or(0, |previous| previous.end_cluster));
        if start < paragraph.end_cluster {
            normalized.push(Paragraph {
                start_cluster: start,
                end_cluster: paragraph.end_cluster,
                align: paragraph.align,
            });
        }
    }
    fill_paragraph_gaps(&mut normalized, new_count);
    *paragraphs = normalized;
}

/// 编辑后平移 inline object。
///
/// 删除段**内部**的对象随之消失(它锚定的内容没了);编辑点之前的原位、
/// 之后的平移;位置恰在编辑点的跟随插入内容之后。
///
/// 去重是必需的:多个对象可能被压到同一编辑点,而构造期禁止重复位置——
/// 该不变量必须在编辑期同样成立,否则宿主查询会拿到两个声称同一锚点的对象。
/// 去重时按 `object_id` 稳定排序后保留**第一个**,使结果与输入顺序无关(可复算)。
fn shift_inline_objects(
    objects: &mut Vec<InlineObject>,
    start: usize,
    end: usize,
    inserted: usize,
    delta: isize,
    new_count: usize,
) {
    let mut shifted = Vec::with_capacity(objects.len());
    for object in objects.iter() {
        let position = object.at_cluster;
        // 被删除段吞掉的对象随之消失。
        if position > start && position < end {
            continue;
        }
        let new_position = if position < start {
            position
        } else if position == start {
            // 恰在编辑点:跟随插入内容之后,保持「插在哪个簇之前」的语义。
            (start + inserted).min(new_count)
        } else {
            (position as isize + delta).max(0) as usize
        };
        shifted.push(InlineObject {
            at_cluster: new_position.min(new_count),
            object_id: object.object_id.clone(),
        });
    }
    // 稳定排序后按位置去重:同位置保留 id 最小者,使结果可复算。
    shifted.sort_by(|a, b| a.at_cluster.cmp(&b.at_cluster).then(a.object_id.cmp(&b.object_id)));
    shifted.dedup_by_key(|object| object.at_cluster);
    *objects = shifted;
}

/// 两侧样式表变化覆盖的簇区间,用于 `set_styles` 的失效范围。
fn style_extent(old: &[StyleSpan], new: &[StyleSpan]) -> (usize, usize) {
    let old_end = old.last().map_or(0, |span| span.end_cluster);
    let new_end = new.last().map_or(0, |span| span.end_cluster);
    (0, old_end.max(new_end))
}

#[cfg(test)]
#[path = "text_document_tests.rs"]
mod tests;