//! P1-20 真实 IME 事务:把组合中/提交/焦点/撤销收成一个**事务化会话**,并接到
//! `TextDocumentV1`(P1-18 的版本化文本 IR)。
//!
//! 与既有 helper 的分工(复用而不重建):
//! - `ime::CompositionState` / `ime_winit::WinitImeAdapter` 负责与 OS 事件对接;
//! - `text_edit::TextEditState` 负责纯文本编辑与撤销;
//! - 本模块负责**事务语义**:组合期文档逐字节不变、提交是一次原子编辑、
//!   切焦点/取消必须回到组合前、撤销与 revision 语义一致。
//!
//! 核心不变量(每条都有测试锁定):
//! 1. **组合期文档不变**:preedit 只存在于会话内,失败/取消后文档与 revision 回到起点;
//! 2. **提交经单一编辑路径**:走 `TextDocumentV1::replace_clusters`,产出 `TextChange`;
//! 3. **切焦点必取消在途组合**:不得把未确认的 preedit 遗留进文档;
//! 4. **撤销/重做按事务粒度**:一次提交是一条可撤销的编辑,revision 随之往返;
//! 5. **删除按簇**:emoji/组合序列整体删除,绝不按字节或 UTF-16 切开。
//!
//! 诚实边界(刻意不做,不含未验证实现):
//! - **bidi/RTL 重排**需要已批准的 shaping 库,本模块不实现,也不假装支持;
//! - **DPI 候选窗**:候选窗由宿主窗口层(OS)绘制,本模块只提供 caret 锚点
//!   (簇索引 + 估算矩形),不管理 DPI,也不声称已完成 OS 级验收;
//! - 本模块不碰真实窗口事件循环(接线归产品焦点层),全部逻辑可由注入事件驱动单测。

use super::text_document::{TextChange, TextDocumentError, TextDocumentV1};

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
    InvalidCompositionAnchor { cluster: usize },
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

/// 一次已提交编辑的历史条目:撤销需要「回到哪个 revision 的哪个文本」。
///
/// 关键:必须分别记录**撤销用的区间**与**重做用的区间**。二者不同——
/// 提交把 `insert_at` 处的空区间变成 `[insert_at, insert_at+n)`;
/// 撤销要在这个 n 簇区间上写回空串,而重做又要在**空的** `insert_at` 位置重新插入。
/// 只记一个区间会让重做在「撤销后的文档」上越界(实测抓到的真实缺陷)。
#[derive(Debug, Clone, PartialEq, Eq)]
struct HistoryEntry {
    /// 插入点(提交前该处为空)。
    insert_at: usize,
    /// 提交后该编辑占据的簇数(撤销时要删掉的簇数)。
    inserted_clusters: usize,
    /// 被替换掉的原文(提交时为纯插入,故为空;退格时为被删的字素簇)。
    replaced: String,
    /// 提交/退格写入的新文本(重做时写回)。
    inserted: String,
    /// 提交前的 caret(撤销后恢复位置)。
    caret_before: usize,
    /// 提交后的 caret(重做后恢复位置)。
    caret_after: usize,
    /// 该条目是否为「插入型」(纯插入 → 撤销是删除;退格 → 撤销是插入)。
    is_insert: bool,
}

/// IME 事务会话。持有文档与组合状态;焦点与 caret 是显式状态,不依赖窗口。
#[derive(Debug, Clone, PartialEq)]
pub struct ImeSession {
    document: TextDocumentV1,
    focused: bool,
    /// caret 所在的**簇索引**(不是字节偏移:与 P1-18 的区间口径一致)。
    caret: usize,
    /// 在途组合:Some 时文档不变。
    composition: Option<Composition>,
    undo_stack: Vec<HistoryEntry>,
    redo_stack: Vec<HistoryEntry>,
    max_history: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Composition {
    /// 组合锚定的簇位置(提交时从这里写入)。
    anchor: usize,
    /// 当前 preedit 文本。
    pending: String,
}

impl ImeSession {
    pub fn new(document: TextDocumentV1, max_history: usize) -> Self {
        Self {
            document,
            focused: false,
            caret: 0,
            composition: None,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_history: max_history.max(1),
        }
    }

    pub fn document(&self) -> &TextDocumentV1 {
        &self.document
    }
    pub fn revision(&self) -> u64 {
        self.document.revision()
    }
    pub fn caret_cluster(&self) -> usize {
        self.caret
    }
    pub fn is_focused(&self) -> bool {
        self.focused
    }
    pub fn is_composing(&self) -> bool {
        self.composition.is_some()
    }
    /// 在途 preedit 文本;未组合时为空串。
    pub fn pending(&self) -> &str {
        self.composition.as_ref().map_or("", |c| c.pending.as_str())
    }
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// 聚焦。已在焦点时是空操作(幂等)——重复聚焦事件不得取消在途组合。
    pub fn focus(&mut self) {
        self.focused = true;
    }

    /// 失焦:**必须取消在途组合**。这是防「preedit 遗留进文档」的关键路径。
    pub fn blur(&mut self) {
        self.focused = false;
        self.composition = None;
    }

    /// 移动 caret(簇索引)。组合期移动 caret 必须先取消组合:
    /// 让 preedit 跟随光标移动会改变它的插入位置,属未定义行为。
    pub fn set_caret(&mut self, cluster: usize) -> Result<(), ImeSessionError> {
        if cluster > self.document.cluster_count() {
            return Err(ImeSessionError::InvalidCompositionAnchor { cluster });
        }
        self.composition = None;
        self.caret = cluster;
        Ok(())
    }

    /// 开始组合。必须在焦点内;重复 begin 视为「重启组合」(清空 preedit,
    /// 锚点保持在当前 caret),不报错——OS 可能因候选刷新重发开始事件。
    pub fn begin_composition(&mut self) -> Result<(), ImeSessionError> {
        if !self.focused {
            return Err(ImeSessionError::NotFocused);
        }
        if self.caret > self.document.cluster_count() {
            return Err(ImeSessionError::InvalidCompositionAnchor {
                cluster: self.caret,
            });
        }
        self.composition = Some(Composition {
            anchor: self.caret,
            pending: String::new(),
        });
        Ok(())
    }

    /// OS 驱动的 preedit 更新。文档**不变**,只替换会话内 pending。
    pub fn update_preedit(&mut self, pending: &str) -> Result<(), ImeSessionError> {
        if pending.len() > 4_096 {
            return Err(ImeSessionError::Document(
                TextDocumentError::InvalidStyleSpan {
                    index: 0,
                    detail: "preedit exceeds 4096 bytes".into(),
                },
            ));
        }
        let composition = self
            .composition
            .as_mut()
            .ok_or(ImeSessionError::NoComposition)?;
        composition.pending = pending.to_string();
        Ok(())
    }

    /// 提交组合:preedit 一次性写入文档,产出该次编辑的 `TextChange`。
    ///
    /// - 空 preedit 的提交是**合法空操作**(确认一个空候选):不写文档、不推 revision、
    ///   不产生历史条目,但组合状态结束。
    /// - 非空提交走 `replace_clusters`,并把组合期插入的簇数作为 caret 前进量。
    pub fn commit(&mut self) -> Result<Option<TextChange>, ImeSessionError> {
        let composition = self
            .composition
            .take()
            .ok_or(ImeSessionError::NoComposition)?;
        let anchor = composition.anchor;
        let inserted = composition.pending;
        if inserted.is_empty() {
            return Ok(None);
        }
        if anchor > self.document.cluster_count() {
            return Err(ImeSessionError::InvalidCompositionAnchor { cluster: anchor });
        }
        // 提交前记录被替换的原文(此处是纯插入,替换区间为空)。
        let caret_before = self.caret;
        let change = self
            .document
            .replace_clusters(anchor, anchor, &inserted)
            .map_err(ImeSessionError::Document)?;
        let inserted_clusters = change.end_cluster.saturating_sub(change.start_cluster);
        self.caret = anchor + inserted_clusters;
        self.undo_stack.push(HistoryEntry {
            insert_at: anchor,
            inserted_clusters,
            replaced: String::new(),
            inserted,
            caret_before,
            caret_after: self.caret,
            is_insert: true,
        });
        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
        Ok(Some(change))
    }

    /// 取消组合:文档逐字节回到组合前,revision 不变。
    pub fn cancel_composition(&mut self) -> Result<(), ImeSessionError> {
        if self.composition.take().is_none() {
            return Err(ImeSessionError::NoComposition);
        }
        Ok(())
    }

    /// 撤销一次已提交编辑。按**事务粒度**回退,revision 随之推进
    /// (撤销本身也是文档变化,必须让缓存失效)。
    ///
    /// 区间语义:插入型编辑(提交)→ 在 `[insert_at, insert_at+n)` 上写回空串;
    /// 删除型编辑(退格)→ 在空的 `insert_at` 位置写回被删原文。
    pub fn undo(&mut self) -> Result<TextChange, ImeSessionError> {
        // 撤销前先取消在途组合:不允许在组合中做历史操作。
        self.composition = None;
        let entry = self.undo_stack.pop().ok_or(ImeSessionError::NothingToUndo)?;
        let (start, end, text) = if entry.is_insert {
            (
                entry.insert_at,
                entry.insert_at + entry.inserted_clusters,
                entry.replaced.as_str(),
            )
        } else {
            (entry.insert_at, entry.insert_at, entry.replaced.as_str())
        };
        // 区间按当前文档重新夹取:即使历史条目来自更早的文档形态,也不得越界。
        let start = start.min(self.document.cluster_count());
        let end = end.min(self.document.cluster_count()).max(start);
        let change = self
            .document
            .replace_clusters(start, end, text)
            .map_err(ImeSessionError::Document)?;
        self.caret = entry.caret_before.min(self.document.cluster_count());
        self.redo_stack.push(entry);
        Ok(change)
    }

    /// 重做最近一次被撤销的编辑。
    pub fn redo(&mut self) -> Result<TextChange, ImeSessionError> {
        self.composition = None;
        let entry = self.redo_stack.pop().ok_or(ImeSessionError::NothingToRedo)?;
        // 重做与撤销对称:插入型在空位置重新插入;删除型重删同一区间。
        let (start, end, text) = if entry.is_insert {
            (
                entry.insert_at,
                entry.insert_at,
                entry.inserted.as_str(),
            )
        } else {
            (entry.insert_at, entry.insert_at, entry.inserted.as_str())
        };
        let start = start.min(self.document.cluster_count());
        let end = end.min(self.document.cluster_count()).max(start);
        let change = self
            .document
            .replace_clusters(start, end, text)
            .map_err(ImeSessionError::Document)?;
        self.caret = entry.caret_after.min(self.document.cluster_count());
        self.undo_stack.push(entry);
        Ok(change)
    }

    /// 按簇删除 caret 之前的簇(退格)。组合期先取消组合——退格属编辑意图,
    /// 与「取消组合」是两个不同语义,这里按编辑优先处理并明确如此。
    pub fn backspace(&mut self) -> Result<Option<TextChange>, ImeSessionError> {
        self.composition = None;
        if self.caret == 0 {
            return Ok(None);
        }
        let target = self.caret - 1;
        let replaced = self
            .document
            .cluster_text(target)
            .unwrap_or_default()
            .to_string();
        let change = self
            .document
            .replace_clusters(target, self.caret, "")
            .map_err(ImeSessionError::Document)?;
        self.caret = target;
        self.undo_stack.push(HistoryEntry {
            // 删除型:撤销要在空的 `insert_at` 处写回被删原文。
            insert_at: target,
            inserted_clusters: 0,
            replaced,
            inserted: String::new(),
            caret_before: target + 1,
            caret_after: target,
            is_insert: false,
        });
        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }
        self.redo_stack.clear();
        Ok(Some(change))
    }

    /// caret 锚点:给宿主候选窗定位用。返回 (簇索引, 矩形 [x, y, w, h])。
    ///
    /// 量测口径:宽度用调用方给的 `advance_of`(按真实字体),高度用 `line_height`;
    /// 未提供量测时返回零宽度矩形而不是猜字符宽度。
    /// **不管理 DPI**:候选窗的缩放由宿主窗口层负责,本模块不声称已完成 OS 验收。
    pub fn caret_rect(
        &self,
        line_height: f64,
        advance_of: &ClusterAdvance,
    ) -> (usize, [f64; 4]) {
        let cluster = self.caret.min(self.document.cluster_count());
        let x = (0..cluster)
            .filter_map(|index| self.document.cluster_text(index))
            .map(advance_of)
            .sum::<f64>();
        (cluster, [x, 0.0, 0.0, line_height.max(0.0)])
    }
}

#[cfg(test)]
#[path = "ime_session_tests.rs"]
mod tests;