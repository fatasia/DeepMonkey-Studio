use deep_engine_native::runtime_package::{
    RuntimeContentHash, RuntimeResourceIndexEntry, RuntimeResourceKind as Kind,
    RuntimeResourcePlanAction as Action, RuntimeResourcePlanEntry,
    plan_runtime_package_resource_diff,
};

fn sha(seed: u64) -> String {
    format!("{seed:064x}")
}

fn entry(id: &str, kind: Kind, revision: u64, hash: &str) -> RuntimeResourceIndexEntry {
    RuntimeResourceIndexEntry {
        id: id.to_owned(),
        kind,
        revision,
        content_hash: RuntimeContentHash {
            algorithm: "sha256".to_owned(),
            value: hash.to_owned(),
        },
    }
}

fn plan_entry(
    action: Action,
    id: &str,
    kind: Kind,
    revision: u64,
    hash: &str,
) -> RuntimeResourcePlanEntry {
    RuntimeResourcePlanEntry {
        action,
        id: id.to_owned(),
        kind,
        revision,
        content_hash: RuntimeContentHash {
            algorithm: "sha256".to_owned(),
            value: hash.to_owned(),
        },
    }
}

#[test]
fn identical_indexes_plan_nothing() {
    let old = [
        entry("scene.main", Kind::RenderPacket, 1, &sha(1)),
        entry("scene.pack", Kind::ShaderPackage, 2, &sha(2)),
    ];
    let new = [
        entry("scene.main", Kind::RenderPacket, 1, &sha(1)),
        entry("scene.pack", Kind::ShaderPackage, 2, &sha(2)),
    ];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    assert!(plan.is_empty(), "{plan:?}");
    assert_eq!(plan.reused, 2);
    let empty = plan_runtime_package_resource_diff(&[], &[]).unwrap();
    assert!(empty.is_empty(), "{empty:?}");
    assert_eq!(empty.reused, 0);
}

#[test]
fn plans_added_resources() {
    let old = [entry("scene.main", Kind::RenderPacket, 1, &sha(1))];
    let new = [
        entry("scene.ibl", Kind::IblEnvironment, 1, &sha(9)),
        entry("scene.main", Kind::RenderPacket, 1, &sha(1)),
    ];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    assert_eq!(
        plan.entries,
        vec![plan_entry(
            Action::Add,
            "scene.ibl",
            Kind::IblEnvironment,
            1,
            &sha(9)
        )]
    );
    assert_eq!(plan.reused, 1);
}

#[test]
fn plans_removed_resources() {
    let old = [
        entry("scene.main", Kind::RenderPacket, 1, &sha(1)),
        entry("scene.old", Kind::ShaderPackage, 4, &sha(4)),
    ];
    let new = [entry("scene.main", Kind::RenderPacket, 1, &sha(1))];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    assert_eq!(
        plan.entries,
        vec![plan_entry(
            Action::Remove,
            "scene.old",
            Kind::ShaderPackage,
            4,
            &sha(4)
        )]
    );
    assert_eq!(plan.reused, 1);
}

#[test]
fn plans_revision_bump_as_replace() {
    let old = [entry("scene.main", Kind::RenderPacket, 1, &sha(1))];
    let new = [entry("scene.main", Kind::RenderPacket, 2, &sha(2))];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    assert_eq!(
        plan.entries,
        vec![plan_entry(
            Action::Replace,
            "scene.main",
            Kind::RenderPacket,
            2,
            &sha(2)
        )]
    );
    assert_eq!(plan.reused, 0);
    // revision 是资源身份:即使内容哈希未变,bump revision 也要按 replace 重载。
    let new = [entry("scene.main", Kind::RenderPacket, 2, &sha(1))];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    assert_eq!(
        plan.entries,
        vec![plan_entry(
            Action::Replace,
            "scene.main",
            Kind::RenderPacket,
            2,
            &sha(1)
        )]
    );
}

#[test]
fn fails_closed_when_revision_is_unchanged_but_hash_differs() {
    for (old_hash, new_hash) in [(sha(1), sha(2)), (sha(3), sha(3))] {
        let old = [entry("scene.main", Kind::RenderPacket, 3, &old_hash)];
        let new = [entry("scene.main", Kind::RenderPacket, 3, &new_hash)];
        // 第二轮仅改 algorithm:同 revision 下哈希口径变化同样不可裁决。
        let mut new = new;
        new[0].content_hash.algorithm = "sha512".to_owned();
        let error = plan_runtime_package_resource_diff(&old, &new).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("keeps revision 3"), "{message}");
        assert!(message.contains("content hash"), "{message}");
        assert!(message.contains("revision bump"), "{message}");
    }
}

#[test]
fn plans_are_identical_regardless_of_input_order() {
    let old_sorted = vec![
        entry("scene.a", Kind::RenderPacket, 1, &sha(1)),
        entry("scene.b", Kind::IblEnvironment, 1, &sha(2)),
        entry("scene.c", Kind::Deep2dRuntime, 5, &sha(3)),
        entry("scene.d", Kind::ShaderPackage, 2, &sha(4)),
    ];
    let new_sorted = vec![
        entry("scene.a", Kind::RenderPacket, 1, &sha(1)),
        entry("scene.b", Kind::IblEnvironment, 2, &sha(8)),
        entry("scene.c", Kind::Deep2dRuntime, 5, &sha(3)),
        entry("scene.e", Kind::ShaderPackage, 1, &sha(7)),
    ];
    let baseline = plan_runtime_package_resource_diff(&old_sorted, &new_sorted).unwrap();
    assert_eq!(baseline.reused, 2);
    let actions = baseline
        .entries
        .iter()
        .map(|entry| entry.action)
        .collect::<Vec<_>>();
    assert_eq!(actions, [Action::Replace, Action::Remove, Action::Add]);
    let ids = baseline
        .entries
        .iter()
        .map(|entry| entry.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["scene.b", "scene.d", "scene.e"]);

    let mut old_shuffled = old_sorted.clone();
    old_shuffled.reverse();
    let mut new_shuffled = new_sorted.clone();
    new_shuffled.rotate_left(2);
    for (old_view, new_view) in [
        (old_shuffled.as_slice(), new_shuffled.as_slice()),
        (old_sorted.as_slice(), new_shuffled.as_slice()),
        (old_shuffled.as_slice(), new_sorted.as_slice()),
    ] {
        assert_eq!(
            plan_runtime_package_resource_diff(old_view, new_view).unwrap(),
            baseline
        );
    }
}

#[test]
fn rejects_duplicate_ids_within_one_index() {
    let old = [entry("scene.main", Kind::RenderPacket, 1, &sha(1))];
    let new = [
        entry("scene.main", Kind::RenderPacket, 1, &sha(1)),
        entry("scene.main", Kind::RenderPacket, 2, &sha(2)),
    ];
    let error = plan_runtime_package_resource_diff(&old, &new).unwrap_err();
    assert!(
        error.to_string().contains("duplicate runtime resource id"),
        "{error}"
    );
}

#[test]
fn same_id_with_different_kind_plans_remove_then_add() {
    let old = [entry("scene.effect", Kind::ShaderPackage, 1, &sha(1))];
    let new = [entry("scene.effect", Kind::IblEnvironment, 1, &sha(2))];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    // 计划按 (id, kind) 排序:IblEnvironment 声明序在 ShaderPackage 之前。
    assert_eq!(
        plan.entries,
        vec![
            plan_entry(
                Action::Add,
                "scene.effect",
                Kind::IblEnvironment,
                1,
                &sha(2)
            ),
            plan_entry(
                Action::Remove,
                "scene.effect",
                Kind::ShaderPackage,
                1,
                &sha(1)
            ),
        ]
    );
    assert_eq!(plan.reused, 0);
}

#[test]
fn plan_serializes_with_stable_action_names() {
    let old = [entry("scene.main", Kind::RenderPacket, 1, &sha(1))];
    let new = [
        entry("scene.main", Kind::RenderPacket, 2, &sha(2)),
        entry("scene.pack", Kind::ShaderPackage, 1, &sha(3)),
    ];
    let plan = plan_runtime_package_resource_diff(&old, &new).unwrap();
    let json = serde_json::to_string(&plan).unwrap();
    assert!(json.contains("\"action\":\"replace\""), "{json}");
    assert!(json.contains("\"action\":\"add\""), "{json}");
    assert!(json.contains("\"contentHash\""), "{json}");
    assert!(json.contains("\"reused\":0"), "{json}");
}
