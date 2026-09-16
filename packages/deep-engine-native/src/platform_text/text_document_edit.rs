//! 编辑映射在 UTF-8 字节上定义，再投影到完整新文本的字素边界。

use super::{InlineObject, Paragraph, StyleSpan};

pub(super) struct EditMap<'a> {
    pub old: &'a [usize],
    pub new: &'a [usize],
    pub start: usize,
    pub end: usize,
    pub inserted_bytes: usize,
}

impl EditMap<'_> {
    fn byte(&self, cluster: usize, right: bool) -> usize {
        let byte = self.old[cluster];
        let start = self.old[self.start];
        let end = self.old[self.end];
        if byte < start || (byte == start && !right) {
            byte
        } else if byte >= end {
            start + self.inserted_bytes + (byte - end)
        } else if right {
            start + self.inserted_bytes
        } else {
            start
        }
    }

    pub fn left(&self, cluster: usize) -> usize {
        self.new
            .partition_point(|&byte| byte <= self.byte(cluster, false))
            - 1
    }

    pub fn right(&self, cluster: usize) -> usize {
        self.new
            .partition_point(|&byte| byte < self.byte(cluster, true))
    }

    pub fn styles(&self, source: &[StyleSpan]) -> Vec<StyleSpan> {
        let mut result: Vec<StyleSpan> = Vec::with_capacity(source.len());
        for span in source {
            let start = self
                .left(span.start_cluster)
                .max(result.last().map_or(0, |span| span.end_cluster));
            let end = self.right(span.end_cluster);
            // 合并到同一簇的区间由左侧样式拥有，后续区间不覆盖它。
            if start < end {
                result.push(StyleSpan {
                    start_cluster: start,
                    end_cluster: end,
                    style: span.style,
                });
            }
        }
        result
    }

    pub fn paragraphs(&self, source: &[Paragraph]) -> Vec<Paragraph> {
        let mut result: Vec<Paragraph> = Vec::with_capacity(source.len());
        for paragraph in source {
            let start = self
                .left(paragraph.start_cluster)
                .max(result.last().map_or(0, |paragraph| paragraph.end_cluster));
            let end = self.right(paragraph.end_cluster);
            if start < end {
                result.push(Paragraph {
                    start_cluster: start,
                    end_cluster: end,
                    align: paragraph.align,
                });
            }
        }
        result
    }

    pub fn objects(&self, source: &[InlineObject]) -> Vec<InlineObject> {
        let mut result: Vec<_> = source
            .iter()
            .filter(|object| object.at_cluster <= self.start || object.at_cluster >= self.end)
            .map(|object| InlineObject {
                at_cluster: self.right(object.at_cluster),
                object_id: object.object_id.clone(),
            })
            .collect();
        result.sort_by(|a, b| {
            a.at_cluster
                .cmp(&b.at_cluster)
                .then(a.object_id.cmp(&b.object_id))
        });
        result.dedup_by_key(|object| object.at_cluster);
        result
    }

    /// 附加符、旗帜重配对等会改变编辑范围外的簇，直到后缀重新同步。
    pub fn affected(&self, old_text: &str, new_text: &str) -> (usize, usize, usize) {
        let old_count = self.old.len() - 1;
        let new_count = self.new.len() - 1;
        let mut prefix = 0;
        while prefix < self.start.min(new_count)
            && old_text[self.old[prefix]..self.old[prefix + 1]]
                == new_text[self.new[prefix]..self.new[prefix + 1]]
        {
            prefix += 1;
        }
        let mut suffix = 0;
        while suffix < old_count - self.end && suffix < new_count - prefix {
            let old = old_count - suffix - 1;
            let new = new_count - suffix - 1;
            if old_text[self.old[old]..self.old[old + 1]]
                != new_text[self.new[new]..self.new[new + 1]]
            {
                break;
            }
            suffix += 1;
        }
        (prefix, old_count - suffix, new_count - suffix)
    }
}
