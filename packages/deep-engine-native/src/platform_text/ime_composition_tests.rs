use super::*;

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

#[test]
fn commit_writes_once_and_advances_the_caret() {
    let mut session = session("ab");
    session.focus();
    session.set_caret(1).unwrap();
    session.begin_composition().unwrap();
    session.update_preedit("中").unwrap();

    let change = session
        .commit()
        .unwrap()
        .expect("non-empty commit yields a change");
    assert_eq!(session.document().text(), "a中b");
    assert_eq!(change.previous_revision, 1);
    assert_eq!(change.revision, 2, "提交推进 revision");
    assert!(change.cluster_count_changed);
    assert_eq!(session.caret_cluster(), 2, "caret 落在插入内容之后");
    assert!(!session.is_composing());
}

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

#[test]
fn illegal_transitions_are_rejected_explicitly() {
    let mut session = session("ab");
    // 未组合时 update/commit/cancel 全部拒绝。
    assert_eq!(
        session.update_preedit("x"),
        Err(ImeSessionError::NoComposition)
    );
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
