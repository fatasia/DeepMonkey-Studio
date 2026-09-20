use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const MAX_BYTES: u64 = 1_048_576;
pub const MAX_NOTES: usize = 1000;
/// Rebase origins are world-f64 values on this grid
/// (`SceneLocalCoordinateProfile::origin_grid`); any other recorded origin
/// means the document is corrupt.
const ORIGIN_GRID: f64 = 1000.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    pub object: String,
    pub point: [f32; 3],
    pub label: String,
}

/// The coordinate frame a persisted document was written in: the runtime
/// origin of the dynamic coordinate rebase at save time. The origin is the
/// frame identity — world f64 on the 1000-unit grid (see
/// `deep_engine_native::runtime_coordinates`).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnnotationFrame {
    pub origin: [f64; 3],
}

/// Frame context of the caller. `runtime` is the origin the f32
/// `Annotation::point` values are expressed in right now; `authored` is the
/// package-authored origin that version 1 documents (written before
/// frame-aware persistence) are interpreted in. World f64 stays the
/// authoring authority across both.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnnotationFrames {
    pub runtime: [f64; 3],
    pub authored: [f64; 3],
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    scene: String,
    /// `None` only in version 1 documents: they predate frame-aware
    /// persistence and never carried a frame.
    frame: Option<AnnotationFrame>,
    notes: Vec<Annotation>,
}

#[derive(Default)]
pub struct Annotations {
    pub notes: Vec<Annotation>,
    pub draft: Option<Annotation>,
    pub active: Option<usize>,
    pub preedit: String,
    saved: Vec<Annotation>,
}

impl Annotations {
    pub fn rebase_local(&mut self, delta: [f32; 3]) {
        for note in self
            .notes
            .iter_mut()
            .chain(self.saved.iter_mut())
            .chain(self.draft.iter_mut())
        {
            for axis in 0..3 {
                note.point[axis] += delta[axis];
            }
        }
    }
    pub fn dirty(&self) -> bool {
        self.notes != self.saved
    }

    pub fn preserve(
        &mut self,
        path: &Path,
        scene: &str,
        frames: AnnotationFrames,
    ) -> Result<(), String> {
        if self.draft.is_some() {
            return Err("finish or cancel the annotation draft before changing scene".into());
        }
        if self.dirty() {
            self.save(path, scene, frames)?;
        }
        Ok(())
    }

    pub fn commit(&mut self) -> bool {
        let Some(note) = self.draft.as_ref() else {
            return false;
        };
        if note.label.trim().is_empty() || self.notes.len() >= MAX_NOTES {
            return false;
        }
        self.notes.push(self.draft.take().unwrap());
        self.active = Some(self.notes.len() - 1);
        true
    }

    pub fn save(
        &mut self,
        path: &Path,
        scene: &str,
        frames: AnnotationFrames,
    ) -> Result<(), String> {
        validate(&self.notes)?;
        validate_frame_origin(frames.runtime)?;
        let bytes = serde_json::to_vec_pretty(&Document {
            version: 2,
            scene: scene.into(),
            frame: Some(AnnotationFrame {
                origin: frames.runtime,
            }),
            notes: self.notes.clone(),
        })
        .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("annotation file exceeds 1 MiB".into());
        }
        let parent = path.parent().ok_or("annotation directory is missing")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&temporary, path).map_err(|e| e.to_string())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        } else {
            self.saved.clone_from(&self.notes);
        }
        result
    }

    pub fn load(
        &mut self,
        path: &Path,
        scene: &str,
        objects: &[&str],
        frames: AnnotationFrames,
    ) -> Result<(), String> {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("annotation source is not a file".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("annotation file exceeds 1 MiB".into());
        }
        validate_frame_origin(frames.runtime)?;
        let document: Document = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let recorded = recorded_frame(&document, frames)?;
        if document.scene != scene {
            return Err("annotation version or scene differs".into());
        }
        validate(&document.notes)?;
        if document
            .notes
            .iter()
            .any(|note| !objects.contains(&note.object.as_str()))
        {
            return Err("annotation references an object absent from this scene".into());
        }
        self.notes = match_runtime_frame(document.notes, recorded, frames.runtime)?;
        self.saved.clone_from(&self.notes);
        self.preedit.clear();
        self.draft = None;
        self.active = None;
        Ok(())
    }
}

/// Resolves the origin a document's points were authored in. Version 1
/// predates frame-aware persistence: its writers only ever saved locals of
/// the authored package frame (the dynamic coordinate rebase did not exist
/// yet), so v1 is interpreted in the authored frame instead of being
/// rejected — refusing these files would silently discard every annotation
/// saved before this fix, while the authored-frame reading reproduces the
/// v1 contract exactly. Version 2 must carry a grid-aligned frame or the
/// load fails closed.
fn recorded_frame(document: &Document, frames: AnnotationFrames) -> Result<[f64; 3], String> {
    match document.version {
        1 => {
            if document.frame.is_some() {
                return Err("annotation frame is unexpected in a version 1 document".into());
            }
            validate_frame_origin(frames.authored)?;
            Ok(frames.authored)
        }
        2 => {
            let frame = document.frame.ok_or("annotation frame is missing")?;
            validate_frame_origin(frame.origin)?;
            Ok(frame.origin)
        }
        _ => Err("annotation version or scene differs".into()),
    }
}

/// Restores notes recorded in `recorded` into the caller's `runtime` frame.
/// The world position `recorded + point` is the authority: it is recomputed
/// in f64 and re-expressed in the runtime frame through the same scene
/// coordinate budgets used everywhere else, so a note that cannot move
/// without drift fails the load instead of shifting silently. Identical
/// frames keep the persisted bits untouched.
fn match_runtime_frame(
    notes: Vec<Annotation>,
    recorded: [f64; 3],
    runtime: [f64; 3],
) -> Result<Vec<Annotation>, String> {
    if recorded == runtime {
        return Ok(notes);
    }
    notes
        .into_iter()
        .map(|mut note| {
            let world = deep_engine_native::runtime_coordinates::local_to_world(
                note.point.map(f64::from),
                recorded,
            )?;
            let local = deep_engine_native::runtime_coordinates::world_to_local(world, runtime)?;
            note.point = local.map(|value| value as f32);
            Ok(note)
        })
        .collect()
}

fn validate_frame_origin(origin: [f64; 3]) -> Result<(), String> {
    if origin
        .iter()
        .any(|value| !value.is_finite() || value % ORIGIN_GRID != 0.0)
    {
        return Err("annotation coordinate frame origin is corrupt".into());
    }
    Ok(())
}

fn validate(notes: &[Annotation]) -> Result<(), String> {
    if notes.len() > MAX_NOTES
        || notes.iter().any(|note| {
            note.object.is_empty()
                || note.object.len() > 1024
                || note.label.trim().is_empty()
                || note.label.chars().count() > 256
                || note.label.chars().any(char::is_control)
                || note.point.iter().any(|v| !v.is_finite())
        })
    {
        return Err("annotation has invalid identity, text, coordinates or count".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "player_annotations_tests.rs"]
mod tests;
