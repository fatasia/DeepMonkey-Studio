use super::TextDocumentError;

/// caret 矩形的量测口径:调用方按实际字体给出簇宽。
/// 用一个闭包而不是内建字表,是为了不与 P1-19 的字体身份重复,也不猜字体。
pub type ClusterAdvance = dyn Fn(&str) -> f64;

#[derive(Debug, Clone, PartialEq)]
pub enum ImeSessionError {
    /// 在无焦点时开始组合;必须显式聚焦,避免事件串页。
    NotFocused,
    /// 当前没有在途组合,却收到 preedit/commit/cancel。
    NoComposition,
    /// 组合位置非法(越界或不在簇边界)。
    InvalidCompositionAnchor {
        cluster: usize,
    },
    /// 文档编辑失败(透传 P1-18 的错误)。
    Document(TextDocumentError),
    /// 没有可撤销/重做的编辑。
    NothingToUndo,
    NothingToRedo,
}

impl std::fmt::Display for ImeSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFocused => write!(f, "IME session has no focus"),
            Self::NoComposition => write!(f, "no composition is active"),
            Self::InvalidCompositionAnchor { cluster } => {
                write!(f, "composition anchor cluster {cluster} is invalid")
            }
            Self::Document(error) => write!(f, "{error}"),
            Self::NothingToUndo => write!(f, "nothing to undo"),
            Self::NothingToRedo => write!(f, "nothing to redo"),
        }
    }
}

impl std::error::Error for ImeSessionError {}

impl From<TextDocumentError> for ImeSessionError {
    fn from(error: TextDocumentError) -> Self {
        Self::Document(error)
    }
}
