use super::super::layout::grapheme_clusters;
use super::{InlineObject, Paragraph, ParagraphAlign, StyleSpan, TextDocumentError};

/// 文本的簇边界:字节偏移序列,长度恒为簇数 + 1,首元素 0、末元素 len。
pub(super) fn cluster_bounds(text: &str) -> Vec<usize> {
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

pub(super) fn validate_styles(
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
pub(super) fn normalize_paragraphs(
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

pub(super) fn validate_inline_objects(
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
