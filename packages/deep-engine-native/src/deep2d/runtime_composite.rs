//! Host-only ordered composition. Wire payloads retain their original schemas.
use super::*;
use std::{collections::BTreeSet, sync::Arc};

#[derive(Debug, Clone, PartialEq)]
pub struct Deep2dLayer {
    pub id: String,
    pub content: Arc<Deep2dRuntimeContent>,
    pub translation: [f64; 2],
    /// Page-space scissor, intersected with every child scissor.
    pub clip: Deep2dRect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Deep2dComposite {
    display_list: Deep2dDisplayList,
    layers: Vec<Deep2dLayer>,
}
impl Deep2dComposite {
    pub fn new(
        id: String,
        revision: u64,
        size: [f64; 2],
        mut layers: Vec<Deep2dLayer>,
    ) -> Result<Self, String> {
        let mut list = Deep2dDisplayList {
            schema_version: 1,
            id,
            revision,
            logical_width: size[0],
            logical_height: size[1],
            scale_factor: 1.0,
            resources: Vec::new(),
            commands: Vec::new(),
            atlases: Vec::new(),
        };
        if layers.len() > 256 {
            return Err("composite layer budget exceeded".into());
        }
        let mut ids = BTreeSet::new();
        for layer in &mut layers {
            if layer.id.is_empty()
                || !ids.insert(layer.id.clone())
                || layer
                    .translation
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > 16_777_216.0)
                || [
                    layer.clip.x,
                    layer.clip.y,
                    layer.clip.width,
                    layer.clip.height,
                ]
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 16_777_216.0)
                || layer.clip.width <= 0.0
                || layer.clip.height <= 0.0
            {
                return Err("invalid composite layer identity, translation or clip".into());
            }
            let mut content = (*layer.content).clone();
            super::runtime_namespace::namespace(&mut content, &layer.id)?;
            let source = content.display_list();
            list.resources.extend(source.resources.clone());
            list.atlases.extend(source.atlases.clone());
            if let Deep2dRuntimeContent::Package(package) = &content {
                list.atlases.extend(package.atlases.clone());
            }
            for command in &source.commands {
                let mut command = command.clone();
                let (transform, clip) = match &mut command {
                    Deep2dCommand::Path(v) => (&mut v.transform, &mut v.clip_rect),
                    Deep2dCommand::Text(v) => (&mut v.transform, &mut v.clip_rect),
                    Deep2dCommand::Image(v) => (&mut v.transform, &mut v.clip_rect),
                };
                transform[4] += layer.translation[0];
                transform[5] += layer.translation[1];
                *clip = match *clip {
                    Some(rect) => intersection(translate_rect(rect, layer.translation), layer.clip),
                    None => Some(layer.clip),
                };
                if clip.is_some() {
                    list.commands.push(command);
                }
            }
            layer.content = Arc::new(content);
        }
        if let Some(issue) = validate_display_list(&list).issues.first() {
            return Err(format!(
                "composite frame: {} at {}",
                issue.message, issue.path
            ));
        }
        Ok(Self {
            display_list: list,
            layers,
        })
    }
    /// Actual namespaced resources/commands; package quads remain in their layers.
    pub fn display_list(&self) -> &Deep2dDisplayList {
        &self.display_list
    }
    pub fn layers(&self) -> &[Deep2dLayer] {
        &self.layers
    }
}

pub(super) fn translate_rect(mut rect: Deep2dRect, offset: [f64; 2]) -> Deep2dRect {
    rect.x += offset[0];
    rect.y += offset[1];
    rect
}
pub(super) fn intersection(a: Deep2dRect, b: Deep2dRect) -> Option<Deep2dRect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let width = (a.x + a.width).min(b.x + b.width) - x;
    let height = (a.y + a.height).min(b.y + b.height) - y;
    (width > 0.0 && height > 0.0).then_some(Deep2dRect {
        x,
        y,
        width,
        height,
    })
}
