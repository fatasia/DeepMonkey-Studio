//! 错误类型:全链路 fail-closed,解析外部输入的每一条失败路径都携带定位信息。
//!
//! 与 TS 侧 `MeshletError`(`packages/deep-engine/src/geometry/types.ts`)的 error code
//! 一一对应,便于双端行为对拍与诊断信息互认。

use std::path::PathBuf;

/// 编译管线错误。`Display` 输出即面向用户的诊断信息,不依赖上下文补充。
#[derive(Debug, thiserror::Error)]
pub enum DagError {
    /// 输入几何非法(TS: `invalid-input`)。
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// 超出构建预算(TS: `budget-exceeded`)。
    #[error("budget exceeded: {label} (limit {limit})")]
    BudgetExceeded {
        /// 超限项的人类可读标签(如 "source triangles")。
        label: String,
        /// 允许的上限。
        limit: u64,
    },

    /// 内部结果非法或不可表示(TS: `invalid-result` / `overflow`)。
    #[error("invalid result: {0}")]
    InvalidResult(String),

    /// 数值溢出:输出尺寸无法在目标宽度内表示。
    #[error("overflow: {0}")]
    Overflow(String),

    /// I/O 失败(文件读写)。
    #[error("io error on {}: {source}", path.display())]
    Io {
        /// 涉及的文件路径。
        path: PathBuf,
        /// 底层 I/O 错误。
        #[source]
        source: std::io::Error,
    },

    /// `.dgc` 文件结构非法(魔数/版本/截断/校验和不符)。
    #[error("dgc format error: {0}")]
    DgcFormat(String),

    /// OBJ 解析失败(行号 + 原因)。
    #[error("obj parse error at line {line}: {reason}")]
    ObjParse {
        /// 出错的 1-based 行号。
        line: usize,
        /// 失败原因。
        reason: String,
    },
}

impl DagError {
    /// 构造 [`DagError::InvalidInput`] 的便捷入口。
    pub(crate) fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput(message.into())
    }

    /// 构造 [`DagError::BudgetExceeded`] 的便捷入口。
    pub(crate) fn budget_exceeded(label: impl Into<String>, limit: u64) -> Self {
        Self::BudgetExceeded {
            label: label.into(),
            limit,
        }
    }

    /// 构造 [`DagError::Overflow`] 的便捷入口。
    pub(crate) fn overflow(message: impl Into<String>) -> Self {
        Self::Overflow(message.into())
    }

    /// 构造 [`DagError::DgcFormat`] 的便捷入口。
    pub(crate) fn dgc_format(message: impl Into<String>) -> Self {
        Self::DgcFormat(message.into())
    }
}

/// 便捷 [`Result`] 别名。
pub type DagResult<T> = Result<T, DagError>;
