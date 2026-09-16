//! 历史保存不可变文档载荷引用，恢复时交换完整内容而非猜测逆簇区间。
use super::{TextChange, TextDocumentError, TextDocumentV1};

#[derive(Debug, Clone, PartialEq)]
pub(super) struct HistoryEntry {
    pub document: TextDocumentV1,
    pub caret: usize,
}

impl HistoryEntry {
    pub fn exchange(
        &mut self,
        document: &mut TextDocumentV1,
        caret: &mut usize,
    ) -> Result<TextChange, TextDocumentError> {
        let change = document.exchange_snapshot(&mut self.document)?;
        std::mem::swap(caret, &mut self.caret);
        Ok(change)
    }
}
