//! P1-20 IME 事务测试。
//!
//! 结构:先锁定五条不变量(组合期文档不变 / 提交单一路径 / 切焦点取消 /
//! 撤销按事务粒度 / 删除按簇),再对抗式构造边界与非法状态转移。

use super::*;

fn session(text: &str) -> ImeSession {
    ImeSession::new(
        TextDocumentV1::new(text, Vec::new(), Vec::new(), Vec::new()).expect("valid"),
        8,
    )
}

fn advance_one(_cluster: &str) -> f64 {
    10.0
}

#[path = "ime_composition_tests.rs"]
mod ime_composition_tests;
#[path = "ime_history_tests.rs"]
mod ime_history_tests;
