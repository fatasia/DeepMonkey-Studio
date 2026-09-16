use super::{TextChange, TextDocumentError, TextDocumentV1, edit::EditMap, validation::*};

impl TextDocumentV1 {
    /// 原区间必须是簇边界；替换可能与两侧合簇，所有元数据统一映射。
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
        let revision = self.next_revision()?;
        let start_byte = self.cluster_bounds[start_cluster];
        let end_byte = self.cluster_bounds[end_cluster];
        let mut text =
            String::with_capacity(self.text.len() - (end_byte - start_byte) + replacement.len());
        text.push_str(&self.text[..start_byte]);
        text.push_str(replacement);
        text.push_str(&self.text[end_byte..]);
        let bounds = cluster_bounds(&text);
        let count = bounds.len() - 1;
        let map = EditMap {
            old: &self.cluster_bounds,
            new: &bounds,
            start: start_cluster,
            end: end_cluster,
            inserted_bytes: replacement.len(),
        };
        let styles = map.styles(&self.styles);
        let paragraphs = normalize_paragraphs(map.paragraphs(&self.paragraphs), count)?;
        let objects = map.objects(&self.inline_objects);
        validate_styles(&styles, count)?;
        validate_inline_objects(&objects, count)?;
        let (start, old_end, end) = map.affected(&self.text, &text);
        let change = TextChange {
            previous_revision: self.revision,
            revision,
            start_cluster: start,
            end_cluster: end,
            previous_end_cluster: old_end,
            cluster_count_changed: self.cluster_count() != count,
        };
        // 候选的内容和元数据全部校验成功后一次替换，失败不改变旧状态。
        self.text = text.into();
        self.cluster_bounds = bounds.into();
        self.styles = styles.into();
        self.paragraphs = paragraphs.into();
        self.inline_objects = objects.into();
        self.revision = revision;
        Ok(change)
    }
}
