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

// ---- 不变量 1:组合期文档逐字节不变 ----

/// preedit 更新与取消都不得触碰文档与 revision。
#[test]
fn composition_never_touches_the_document() {
    let mut session = session("中文");
    session.focus();
    session.set_caret(1).unwrap();
    let before = session.document().clone();
    let revision = session.revision();

    session.begin_composition().unwrap();
    session.update_preedit("shi").unwrap();
    session.update_preedit("shi'ji").unwrap();
    assert_eq!(session.pending(), "shi'ji", "preedit 在会话内可见");
    assert_eq!(session.document(), &before, "组合期文档必须逐字节不变");
    assert_eq!(session.revision(), revision, "组合期不得推进 revision");

    session.cancel_composition().unwrap();
    assert_eq!(session.document(), &before, "取消后文档必须回到组合前");
    assert_eq!(session.revision(), revision, "取消不得推进 revision");
    assert!(!session.is_composing());
    assert_eq!(session.pending(), "");
}

// ---- 不变量 2:提交经单一编辑路径 ----

/// 提交把 preedit 一次性写入并返回 TextChange;caret 前进到插入内容之后。
#[test]
fn commit_writes_once_and_advances_the_caret() {
    let mut session = session("ab");
    session.focus();
    session.set_caret(1).unwrap();
    session.begin_composition().unwrap();
    session.update_preedit("中").unwrap();

    let change = session.commit().unwrap().expect("non-empty commit yields a change");
    assert_eq!(session.document().text(), "a中b");
    assert_eq!(change.previous_revision, 1);
    assert_eq!(change.revision, 2, "提交推进 revision");
    assert_eq!(change.cluster_count_changed, true);
    assert_eq!(session.caret_cluster(), 2, "caret 落在插入内容之后");
    assert!(!session.is_composing());
}

/// 空 preedit 提交是**合法空操作**:不写文档、不推 revision、不进历史。
#[test]
fn empty_commit_is_a_legal_noop() {
    let mut session = session("ab");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("").unwrap();
    let revision = session.revision();

    assert_eq!(session.commit().unwrap(), None, "空提交不产生编辑");
    assert_eq!(session.document().text(), "ab");
    assert_eq!(session.revision(), revision, "空提交不得推进 revision");
    assert!(!session.can_undo(), "空提交不得进历史");
    assert!(!session.is_composing());
}

// ---- 不变量 3:切焦点必取消在途组合 ----

/// 失焦必须丢弃在途 preedit,不得遗留进文档。
#[test]
fn blur_cancels_in_flight_composition() {
    let mut session = session("中文");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("zhong").unwrap();
    let before = session.document().clone();

    session.blur();
    assert!(!session.is_composing(), "失焦必须结束组合");
    assert_eq!(session.pending(), "");
    assert_eq!(session.document(), &before, "失焦不得把 preedit 写进文档");
    // 失焦后再提交必须被拒(没有在途组合)。
    assert_eq!(session.commit(), Err(ImeSessionError::NoComposition));
}

/// 重复 focus 是幂等的,不得取消在途组合。
#[test]
fn repeated_focus_is_idempotent_and_keeps_composition() {
    let mut session = session("中");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("wen").unwrap();
    session.focus();
    assert!(session.is_composing(), "重复聚焦不得取消组合");
    assert_eq!(session.pending(), "wen");
}

/// 未聚焦时不得开始组合(防止事件串页)。
#[test]
fn composition_requires_focus() {
    let mut session = session("中");
    assert_eq!(
        session.begin_composition(),
        Err(ImeSessionError::NotFocused)
    );
    session.blur(); // 已是未聚焦,幂等
    assert_eq!(
        session.begin_composition(),
        Err(ImeSessionError::NotFocused)
    );
}

// ---- 不变量 4:撤销按事务粒度 ----

/// 两次提交是两条独立事务;撤销一次只回退一次提交,revision 随之推进。
#[test]
fn undo_steps_one_transaction_at_a_time() {
    let mut session = session("");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("中").unwrap();
    session.commit().unwrap();
    let after_first = session.revision();

    session.begin_composition().unwrap();
    session.update_preedit("文").unwrap();
    session.commit().unwrap();
    assert_eq!(session.document().text(), "中文");

    let change = session.undo().unwrap();
    assert_eq!(session.document().text(), "中", "只回退最近一次提交");
    assert!(
        change.revision > after_first,
        "撤销本身是文档变化,必须推进 revision 让缓存失效"
    );
    assert!(session.can_redo());

    session.undo().unwrap();
    assert_eq!(session.document().text(), "", "再撤一次回到初始");
    assert!(!session.can_undo());
    assert_eq!(session.undo(), Err(ImeSessionError::NothingToUndo));
}

/// 重做恢复被撤销的编辑,内容与 caret 一致。
#[test]
fn redo_restores_the_committed_text() {
    let mut session = session("");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("中文").unwrap();
    session.commit().unwrap();
    let caret_after_commit = session.caret_cluster();
    session.undo().unwrap();
    assert_eq!(session.caret_cluster(), 0, "撤销回到提交前 caret");

    session.redo().unwrap();
    assert_eq!(session.document().text(), "中文");
    assert_eq!(session.caret_cluster(), caret_after_commit);
    assert_eq!(session.redo(), Err(ImeSessionError::NothingToRedo));
}

/// 撤销会丢弃 redo 栈(新编辑打断重做链)——常见编辑器语义。
#[test]
fn a_new_commit_clears_the_redo_stack() {
    let mut session = session("");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("中").unwrap();
    session.commit().unwrap();
    session.undo().unwrap();
    assert!(session.can_redo());

    session.begin_composition().unwrap();
    session.update_preedit("文").unwrap();
    session.commit().unwrap();
    assert!(!session.can_redo(), "新提交必须清空 redo 链");
    assert_eq!(session.document().text(), "文");
}

// ---- 不变量 5:删除按簇 ----

/// backspace 必须整簇删除:emoji 与组合序列不得被切开。
#[test]
fn backspace_deletes_whole_clusters_never_bytes() {
    // "a👍" 有 2 簇;emoji 是 4 字节但只占 1 簇。
    let mut emoji = session("a👍");
    emoji.focus();
    emoji.set_caret(2).unwrap();
    let change = emoji.backspace().unwrap().expect("non-empty backspace");
    assert_eq!(emoji.document().text(), "a", "emoji 必须整簇删除");
    assert_eq!(change.cluster_count_changed, true);

    // 组合序列同理:"a\u{0301}b" 有 2 簇,删掉基字+组合符整体。
    let mut combining = session("a\u{0301}b");
    combining.focus();
    combining.set_caret(1).unwrap();
    combining.backspace().unwrap();
    assert_eq!(combining.document().text(), "b", "组合序列必须整簇删除");

    // caret 在 0 时退格是空操作。
    let mut at_start = session("ab");
    at_start.focus();
    assert_eq!(at_start.backspace().unwrap(), None);
    assert_eq!(at_start.document().text(), "ab");
}

/// backspace 可撤销,且撤销恢复的是被删掉的原文(含多字节簇)。
#[test]
fn backspace_is_undoable_with_the_original_cluster() {
    let mut session = session("x👍y");
    session.focus();
    session.set_caret(2).unwrap();
    session.backspace().unwrap();
    assert_eq!(session.document().text(), "xy");
    session.undo().unwrap();
    assert_eq!(session.document().text(), "x👍y", "撤销必须还原被删的 emoji");
}

// ---- 对抗式:边界与非法转移 ----

/// 组合中的编辑意图(退格/移动 caret)必须先结束组合,且文档保持自洽。
#[test]
fn editing_intent_during_composition_ends_it_consistently() {
    let mut session = session("中文");
    session.focus();
    session.set_caret(2).unwrap();
    session.begin_composition().unwrap();
    session.update_preedit("x").unwrap();
    // 移动 caret:组合被取消,preedit 不得进入文档。
    session.set_caret(0).unwrap();
    assert!(!session.is_composing());
    assert_eq!(session.document().text(), "中文", "preedit 不得遗留");

    // 退格:组合结束并真正删除一簇。
    session.set_caret(2).unwrap();
    session.begin_composition().unwrap();
    session.update_preedit("y").unwrap();
    session.backspace().unwrap();
    assert!(!session.is_composing());
    assert_eq!(session.document().text(), "中");
}

/// 非法状态转移必须显式拒绝,不得静默忽略。
#[test]
fn illegal_transitions_are_rejected_explicitly() {
    let mut session = session("ab");
    // 未组合时 update/commit/cancel 全部拒绝。
    assert_eq!(session.update_preedit("x"), Err(ImeSessionError::NoComposition));
    assert_eq!(session.commit(), Err(ImeSessionError::NoComposition));
    assert_eq!(
        session.cancel_composition(),
        Err(ImeSessionError::NoComposition)
    );
    // caret 越界拒绝。
    assert_eq!(
        session.set_caret(9),
        Err(ImeSessionError::InvalidCompositionAnchor { cluster: 9 })
    );
    // 越界操作后状态不变。
    assert_eq!(session.document().text(), "ab");
    assert_eq!(session.revision(), 1);
}

/// 超长 preedit 必须被拒绝(预算),且不污染已有组合内容。
#[test]
fn oversized_preedit_is_rejected_without_polluting_state() {
    let mut session = session("中");
    session.focus();
    session.begin_composition().unwrap();
    session.update_preedit("ok").unwrap();
    let oversized = "x".repeat(4_097);
    assert!(session.update_preedit(&oversized).is_err());
    assert_eq!(session.pending(), "ok", "被拒的 preedit 不得覆盖已有内容");
}

/// 到期边界:max_history 生效时旧事务被丢弃,但文档内容正确。
#[test]
fn history_is_bounded_without_corrupting_the_document() {
    let mut session = ImeSession::new(
        TextDocumentV1::new("", Vec::new(), Vec::new(), Vec::new()).unwrap(),
        2,
    );
    session.focus();
    for character in ["一", "二", "三"] {
        session.begin_composition().unwrap();
        session.update_preedit(character).unwrap();
        session.commit().unwrap();
    }
    assert_eq!(session.document().text(), "一二三");
    // 历史上限 2:只能撤两次,第三次必须报 NothingToUndo。
    session.undo().unwrap();
    session.undo().unwrap();
    assert_eq!(session.undo(), Err(ImeSessionError::NothingToUndo));
    assert_eq!(session.document().text(), "一");
}

/// caret 锚点必须按簇累计宽度,且不越界。
#[test]
fn caret_rect_accumulates_cluster_advances() {
    let mut session = session("中文ab");
    session.focus();
    session.set_caret(0).unwrap();
    let (cluster, rect) = session.caret_rect(20.0, &advance_one);
    assert_eq!(cluster, 0);
    assert_eq!(rect[0], 0.0);
    assert_eq!(rect[3], 20.0);

    session.set_caret(3).unwrap();
    let (cluster, rect) = session.caret_rect(20.0, &advance_one);
    assert_eq!(cluster, 3);
    assert_eq!(rect[0], 30.0, "前三个簇各 10 宽");
    assert_eq!(rect[2], 0.0, "宽度不猜:调用方按字体决定");
}