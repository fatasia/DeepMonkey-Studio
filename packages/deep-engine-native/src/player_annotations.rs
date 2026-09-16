use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const MAX_BYTES: u64 = 1_048_576;
pub const MAX_NOTES: usize = 1000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Annotation {
    pub object: String,
    pub point: [f32; 3],
    pub label: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    scene: String,
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
    pub fn dirty(&self) -> bool {
        self.notes != self.saved
    }

    pub fn preserve(&mut self, path: &Path, scene: &str) -> Result<(), String> {
        if self.draft.is_some() {
            return Err("finish or cancel the annotation draft before changing scene".into());
        }
        if self.dirty() {
            self.save(path, scene)?;
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

    pub fn save(&mut self, path: &Path, scene: &str) -> Result<(), String> {
        validate(&self.notes)?;
        let bytes = serde_json::to_vec_pretty(&Document {
            version: 1,
            scene: scene.into(),
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

    pub fn load(&mut self, path: &Path, scene: &str, objects: &[&str]) -> Result<(), String> {
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
        let document: Document = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if document.version != 1 || document.scene != scene {
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
        self.notes = document.notes;
        self.saved.clone_from(&self.notes);
        self.preedit.clear();
        self.draft = None;
        self.active = None;
        Ok(())
    }
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
