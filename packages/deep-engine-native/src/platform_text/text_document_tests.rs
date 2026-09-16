//! P1-18 版本化文本 IR 的合同测试。
//!
//! 覆盖三层:构造校验(越界/乱序/重叠必须拒绝)、查询(样式/段落/inline 二分正确)、
//! 编辑后失效(样式随簇平移、插入继承插入点样式、对象跟随位置、revision 单调)。

use super::*;

fn span(start: usize, end: usize, style: u16) -> StyleSpan {
    StyleSpan {
        start_cluster: start,
        end_cluster: end,
        style: TextStyleId(style),
    }
}

fn document(text: &str) -> TextDocumentV1 {
    TextDocumentV1::new(text, Vec::new(), Vec::new(), Vec::new()).expect("valid document")
}

#[path = "text_document_construction_tests.rs"]
mod text_document_construction_tests;
#[path = "text_document_edit_tests.rs"]
mod text_document_edit_tests;
#[path = "text_document_invariant_tests.rs"]
mod text_document_invariant_tests;
