use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

struct Folder(std::path::PathBuf);
impl Folder {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "native-annotation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn note() -> Annotation {
    Annotation {
        object: "object-1".into(),
        point: [1., 2., 3.],
        label: "检查阀门 1".into(),
    }
}
fn base_frames() -> AnnotationFrames {
    AnnotationFrames {
        runtime: [0.; 3],
        authored: [0.; 3],
    }
}
fn world_of(point: [f32; 3], origin: [f64; 3]) -> [f64; 3] {
    deep_engine_native::runtime_coordinates::local_to_world(point.map(f64::from), origin).unwrap()
}
fn empty_packet() -> deep_engine_native::contract::RenderPacket {
    deep_engine_native::contract::RenderPacket {
        schema: deep_engine_native::contract::CONTRACT_SCHEMA.into(),
        version: 1,
        geometries: Vec::new(),
        materials: Vec::new(),
        instances: Vec::new(),
        textures: Vec::new(),
    }
}

#[test]
fn persistent_annotations_roundtrip_replace_and_keep_previous_state_on_rejected_load() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    let mut annotations = Annotations {
        draft: Some(note()),
        ..Default::default()
    };
    assert!(annotations.commit());
    annotations.save(&path, "scene-a", base_frames()).unwrap();
    let mut restored = Annotations::default();
    restored
        .load(&path, "scene-a", &["object-1"], base_frames())
        .unwrap();
    assert_eq!(restored.notes, annotations.notes);
    annotations.notes[0].label = "更新".into();
    annotations.save(&path, "scene-a", base_frames()).unwrap();
    restored
        .load(&path, "scene-a", &["object-1"], base_frames())
        .unwrap();
    assert_eq!(restored.notes[0].label, "更新");
    assert!(
        restored
            .load(&path, "other", &["object-1"], base_frames())
            .is_err()
    );
    assert!(restored.load(&path, "scene-a", &[], base_frames()).is_err());
    fs::write(&path, b"{").unwrap();
    assert!(
        restored
            .load(&path, "scene-a", &["object-1"], base_frames())
            .is_err()
    );
    assert_eq!(restored.notes[0].label, "更新");
}

#[test]
fn failed_save_never_removes_an_existing_temporary_file() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, b"owned by previous writer").unwrap();
    assert!(
        Annotations::default()
            .save(&path, "scene", base_frames())
            .is_err()
    );
    assert_eq!(fs::read(&temporary).unwrap(), b"owned by previous writer");
}

#[test]
fn malformed_annotation_values_are_rejected_before_write() {
    let mut invalid = note();
    invalid.point[1] = f32::NAN;
    assert!(validate(&[invalid]).is_err());
    let mut invalid = note();
    invalid.label = "x".repeat(257);
    assert!(validate(&[invalid]).is_err());
    assert!(validate(&vec![note(); MAX_NOTES + 1]).is_err());
}

#[test]
fn scene_replacement_saves_dirty_notes_and_blocks_on_draft_or_io_failure() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    let mut annotations = Annotations {
        draft: Some(note()),
        ..Default::default()
    };
    assert!(annotations.preserve(&path, "scene", base_frames()).is_err());
    assert!(annotations.draft.is_some());
    assert!(!path.exists());
    assert!(annotations.commit());
    assert!(annotations.dirty());
    let blocked = folder.0.join("blocked");
    fs::write(&blocked, b"not a directory").unwrap();
    assert!(
        annotations
            .preserve(&blocked.join("notes.json"), "scene", base_frames())
            .is_err()
    );
    assert!(annotations.dirty());
    assert_eq!(annotations.notes, vec![note()]);
    annotations.preserve(&path, "scene", base_frames()).unwrap();
    assert!(!annotations.dirty());
    let mut restored = Annotations::default();
    restored
        .load(&path, "scene", &["object-1"], base_frames())
        .unwrap();
    assert_eq!(restored.notes, annotations.notes);
    annotations.notes.clear();
    assert!(annotations.dirty());
    annotations.preserve(&path, "scene", base_frames()).unwrap();
    restored
        .load(&path, "scene", &["object-1"], base_frames())
        .unwrap();
    assert!(restored.notes.is_empty());
}

/// The known rebase defect: saving after a dynamic coordinate rebase wrote
/// runtime-frame locals without the frame. A v2 document records the frame,
/// so reopening in the authored frame restores the authoring world position
/// with zero drift.
#[test]
fn save_after_rebase_reopens_in_the_authored_frame_without_world_drift() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    let mut content = crate::player_content::PlayerContent::from_packet(empty_packet(), None);
    let view = deep_engine_native::player_view::PlayerView::default()
        .with_eye_target([4010., 8., 16.], [4000., 0., 0.])
        .unwrap();
    // The same primitives the redraw transaction applies to app state.
    let candidate = content.dynamic_coordinate_rebase(view).unwrap().unwrap();
    let delta = candidate.delta();
    content.begin_dynamic_coordinate_rebase(candidate);
    let rebased_origin = content.runtime_coordinate_origin();
    assert_eq!(rebased_origin, [4000., 0., 0.]);
    assert_eq!(content.authored_coordinate_origin(), [0.; 3]);

    // Authored against the base frame: world = [4000.25, -8000.5, 12000].
    let authored_point = [4000.25f32, -8000.5, 12000.0];
    let annotations = Annotations {
        notes: vec![Annotation {
            object: "object-1".into(),
            point: authored_point,
            label: "检查阀门 1".into(),
        }],
        ..Annotations::default()
    };
    let mut annotations = annotations;
    annotations.rebase_local(delta);
    assert_eq!(annotations.notes[0].point, [0.25, -8000.5, 12000.0]);
    annotations
        .save(
            &path,
            "scene-a",
            AnnotationFrames {
                runtime: rebased_origin,
                authored: [0.; 3],
            },
        )
        .unwrap();

    // Reopen in a fresh session: the runtime still sits in the authored frame.
    let mut restored = Annotations::default();
    restored
        .load(
            &path,
            "scene-a",
            &["object-1"],
            AnnotationFrames {
                runtime: [0.; 3],
                authored: [0.; 3],
            },
        )
        .unwrap();
    assert_eq!(restored.notes[0].point, authored_point);
    assert_ne!(
        restored.notes[0].point, annotations.notes[0].point,
        "the frame-aware restore must undo the rebase translation"
    );
    // World f64 is the authority: identical across save, rebase and reload.
    assert_eq!(
        world_of(restored.notes[0].point, [0.; 3]),
        world_of(annotations.notes[0].point, rebased_origin)
    );

    // Resuming inside the recorded frame keeps the persisted bits untouched.
    let mut resumed = Annotations::default();
    resumed
        .load(
            &path,
            "scene-a",
            &["object-1"],
            AnnotationFrames {
                runtime: rebased_origin,
                authored: [0.; 3],
            },
        )
        .unwrap();
    assert_eq!(resumed.notes[0].point, [0.25, -8000.5, 12000.0]);
}

/// Version 1 writers only ever saved locals of the authored package frame
/// (the dynamic rebase did not exist yet), so v1 documents are read in the
/// authored frame instead of being rejected.
#[test]
fn version1_documents_are_interpreted_in_the_authored_frame() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    fs::write(
        &path,
        r#"{"version":1,"scene":"scene-a","notes":[{"object":"object-1","point":[10.5,20.25,-30.0],"label":"检查阀门 1"}]}"#,
    )
    .unwrap();
    let mut restored = Annotations::default();
    // A session whose runtime frame has already rebased to [1000, 0, 0]
    // still restores the world position authored against the base frame.
    restored
        .load(
            &path,
            "scene-a",
            &["object-1"],
            AnnotationFrames {
                runtime: [1000., 0., 0.],
                authored: [0.; 3],
            },
        )
        .unwrap();
    assert_eq!(restored.notes[0].point, [-989.5, 20.25, -30.0]);
    assert_eq!(
        world_of(restored.notes[0].point, [1000., 0., 0.]),
        [10.5, 20.25, -30.0]
    );
}

#[test]
fn version1_documents_reject_a_recorded_frame() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    fs::write(
        &path,
        r#"{"version":1,"scene":"scene-a","frame":{"origin":[0.0,0.0,0.0]},"notes":[{"object":"object-1","point":[1.0,2.0,3.0],"label":"x"}]}"#,
    )
    .unwrap();
    let restored = Annotations {
        notes: vec![note()],
        ..Annotations::default()
    };
    let mut restored = restored;
    assert!(
        restored
            .load(&path, "scene-a", &["object-1"], base_frames())
            .is_err()
    );
    assert_eq!(restored.notes, vec![note()]);
}

#[test]
fn version2_documents_fail_closed_when_the_frame_is_missing() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    fs::write(
        &path,
        r#"{"version":2,"scene":"scene-a","notes":[{"object":"object-1","point":[1.0,2.0,3.0],"label":"x"}]}"#,
    )
    .unwrap();
    let mut restored = Annotations {
        notes: vec![note()],
        ..Annotations::default()
    };
    assert!(
        restored
            .load(&path, "scene-a", &["object-1"], base_frames())
            .is_err()
    );
    assert_eq!(restored.notes, vec![note()]);
}

#[test]
fn version2_documents_fail_closed_when_the_frame_is_corrupt() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    for corrupt in [
        // Off-grid origin: no rebase or package frame can produce it.
        r#"{"version":2,"scene":"scene-a","frame":{"origin":[1000.5,0.0,0.0]},"notes":[]}"#,
        // Non-numeric origin.
        r#"{"version":2,"scene":"scene-a","frame":{"origin":[0.0,"x",0.0]},"notes":[]}"#,
    ] {
        fs::write(&path, corrupt).unwrap();
        let mut restored = Annotations {
            notes: vec![note()],
            ..Annotations::default()
        };
        assert!(
            restored
                .load(&path, "scene-a", &["object-1"], base_frames())
                .is_err(),
            "corrupt frame must be rejected: {corrupt}"
        );
        assert_eq!(restored.notes, vec![note()]);
    }
}

/// A frame change whose conversion would exceed the scene float32 error
/// budget cannot restore the world position faithfully; the load fails and
/// keeps the previous notes instead of moving them silently.
#[test]
fn loads_that_cannot_preserve_world_positions_fail_closed() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    fs::write(
        &path,
        r#"{"version":2,"scene":"scene-a","frame":{"origin":[0.0,0.0,0.0]},"notes":[{"object":"object-1","point":[1000000000.0,0.0,0.0],"label":"x"}]}"#,
    )
    .unwrap();
    let mut restored = Annotations {
        notes: vec![note()],
        ..Annotations::default()
    };
    assert!(
        restored
            .load(
                &path,
                "scene-a",
                &["object-1"],
                AnnotationFrames {
                    runtime: [4000., 0., 0.],
                    authored: [0.; 3],
                },
            )
            .is_err()
    );
    assert_eq!(restored.notes, vec![note()]);
}

#[test]
fn save_rejects_a_runtime_frame_outside_the_rebase_grid() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    assert!(
        Annotations::default()
            .save(
                &path,
                "scene",
                AnnotationFrames {
                    runtime: [1000.5, 0., 0.],
                    authored: [0.; 3],
                },
            )
            .is_err()
    );
    assert!(!path.exists());
}
