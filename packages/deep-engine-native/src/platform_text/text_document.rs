//! 版本化文本、样式、段落和内联对象；不可变载荷共享用于事务历史。
#[path = "text_document_edit.rs"]
mod edit;
#[path = "text_document_mutation.rs"]
mod mutation;
#[path = "text_document_types.rs"]
mod types;
#[path = "text_document_validation.rs"]
mod validation;
pub use types::*;
use validation::*;

/// 版本化文本文档。`text` 是唯一真源,所有区间都是它的簇索引投影。
#[derive(Debug, Clone, PartialEq)]
pub struct TextDocumentV1 {
    schema_version: u32,
    revision: u64,
    text: std::sync::Arc<str>,
    /// 缓存的簇边界(字节偏移)。文本变化时重算;查询样式/段落直接复用。
    cluster_bounds: std::sync::Arc<[usize]>,
    styles: std::sync::Arc<[StyleSpan]>,
    paragraphs: std::sync::Arc<[Paragraph]>,
    inline_objects: std::sync::Arc<[InlineObject]>,
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
            text: text.into(),
            cluster_bounds: cluster_bounds.into(),
            styles: styles.into(),
            paragraphs: paragraphs.into(),
            inline_objects: inline_objects.into(),
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
        let first = self
            .styles
            .partition_point(|span| span.end_cluster <= start);
        let last = self.styles.partition_point(|span| span.start_cluster < end);
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

    /// 整体替换样式表；失败不修改内容或 revision。
    pub fn set_styles(&mut self, styles: Vec<StyleSpan>) -> Result<TextChange, TextDocumentError> {
        validate_styles(&styles, self.cluster_count())?;
        let revision = self.next_revision()?;
        let end = self
            .styles
            .last()
            .map_or(0, |span| span.end_cluster)
            .max(styles.last().map_or(0, |span| span.end_cluster));
        let change = TextChange {
            previous_revision: self.revision,
            revision,
            start_cluster: 0,
            end_cluster: end,
            previous_end_cluster: end,
            cluster_count_changed: false,
        };
        self.styles = styles.into();
        self.revision = revision;
        Ok(change)
    }

    fn next_revision(&self) -> Result<u64, TextDocumentError> {
        self.revision
            .checked_add(1)
            .ok_or(TextDocumentError::RevisionExhausted)
    }

    /// 文本编辑后的光标向右吸附到完整字素边界。
    pub(super) fn caret_after_byte(&self, byte: usize) -> usize {
        self.cluster_bounds
            .partition_point(|&bound| bound < byte.min(self.text.len()))
    }

    pub(super) fn boundary_byte(&self, cluster: usize) -> usize {
        self.cluster_bounds[cluster]
    }

    /// 恢复快照内容，同时保持当前文档 revision 单调。
    pub(super) fn exchange_snapshot(
        &mut self,
        snapshot: &mut Self,
    ) -> Result<TextChange, TextDocumentError> {
        let revision = self.next_revision()?;
        let change = TextChange {
            previous_revision: self.revision,
            revision,
            start_cluster: 0,
            end_cluster: snapshot.cluster_count(),
            previous_end_cluster: self.cluster_count(),
            cluster_count_changed: self.cluster_count() != snapshot.cluster_count(),
        };
        std::mem::swap(self, snapshot);
        self.revision = revision;
        Ok(change)
    }
}

#[cfg(test)]
#[path = "text_document_tests.rs"]
mod tests;
