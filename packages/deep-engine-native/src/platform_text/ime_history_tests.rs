use super::*;

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

#[test]
fn backspace_deletes_whole_clusters_never_bytes() {
    // "a👍" 有 2 簇;emoji 是 4 字节但只占 1 簇。
    let mut emoji = session("a👍");
    emoji.focus();
    emoji.set_caret(2).unwrap();
    let change = emoji.backspace().unwrap().expect("non-empty backspace");
    assert_eq!(emoji.document().text(), "a", "emoji 必须整簇删除");
    assert!(change.cluster_count_changed);

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

#[test]
fn backspace_is_undoable_with_the_original_cluster() {
    let mut session = session("x👍y");
    session.focus();
    session.set_caret(2).unwrap();
    session.backspace().unwrap();
    assert_eq!(session.document().text(), "xy");
    session.undo().unwrap();
    assert_eq!(
        session.document().text(),
        "x👍y",
        "撤销必须还原被删的 emoji"
    );
}

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
