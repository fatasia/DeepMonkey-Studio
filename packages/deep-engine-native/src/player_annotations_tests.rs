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

#[test]
fn persistent_annotations_roundtrip_replace_and_keep_previous_state_on_rejected_load() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    let mut annotations = Annotations {
        draft: Some(note()),
        ..Default::default()
    };
    assert!(annotations.commit());
    annotations.save(&path, "scene-a").unwrap();
    let mut restored = Annotations::default();
    restored.load(&path, "scene-a", &["object-1"]).unwrap();
    assert_eq!(restored.notes, annotations.notes);
    annotations.notes[0].label = "更新".into();
    annotations.save(&path, "scene-a").unwrap();
    restored.load(&path, "scene-a", &["object-1"]).unwrap();
    assert_eq!(restored.notes[0].label, "更新");
    assert!(restored.load(&path, "other", &["object-1"]).is_err());
    assert!(restored.load(&path, "scene-a", &[]).is_err());
    fs::write(&path, b"{").unwrap();
    assert!(restored.load(&path, "scene-a", &["object-1"]).is_err());
    assert_eq!(restored.notes[0].label, "更新");
}

#[test]
fn failed_save_never_removes_an_existing_temporary_file() {
    let folder = Folder::new();
    let path = folder.0.join("notes.json");
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, b"owned by previous writer").unwrap();
    assert!(Annotations::default().save(&path, "scene").is_err());
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
    assert!(annotations.preserve(&path, "scene").is_err());
    assert!(annotations.draft.is_some());
    assert!(!path.exists());
    assert!(annotations.commit());
    assert!(annotations.dirty());
    let blocked = folder.0.join("blocked");
    fs::write(&blocked, b"not a directory").unwrap();
    assert!(
        annotations
            .preserve(&blocked.join("notes.json"), "scene")
            .is_err()
    );
    assert!(annotations.dirty());
    assert_eq!(annotations.notes, vec![note()]);
    annotations.preserve(&path, "scene").unwrap();
    assert!(!annotations.dirty());
    let mut restored = Annotations::default();
    restored.load(&path, "scene", &["object-1"]).unwrap();
    assert_eq!(restored.notes, annotations.notes);
    annotations.notes.clear();
    assert!(annotations.dirty());
    annotations.preserve(&path, "scene").unwrap();
    restored.load(&path, "scene", &["object-1"]).unwrap();
    assert!(restored.notes.is_empty());
}
