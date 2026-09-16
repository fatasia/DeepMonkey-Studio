use super::{RenderLodLevel, RenderLodProfile};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthorSelection {
    pub revision: f64,
    pub levels: Vec<AuthorLevel>,
    pub selected_levels: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorLevel {
    pub geometry: String,
    pub distance: f64,
    pub hysteresis: f64,
}

#[derive(Serialize, Deserialize)]
enum ScreenStrategy {
    #[serde(rename = "screen-space")]
    Screen,
}
#[derive(Serialize, Deserialize)]
enum AuthorStrategy {
    #[serde(rename = "author-selected")]
    Author,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScreenWire {
    #[serde(
        default,
        deserialize_with = "super::types::present",
        skip_serializing_if = "Option::is_none"
    )]
    strategy: Option<ScreenStrategy>,
    levels: Vec<RenderLodLevel>,
    #[serde(
        default,
        deserialize_with = "super::types::present",
        skip_serializing_if = "Option::is_none"
    )]
    hysteresis_ratio: Option<f64>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuthorWire {
    strategy: AuthorStrategy,
    revision: f64,
    levels: Vec<AuthorLevel>,
    #[serde(deserialize_with = "selected_indices")]
    selected_levels: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Wire {
    Screen(ScreenWire),
    Author(AuthorWire),
}

impl<'de> Deserialize<'de> for RenderLodProfile {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = super::lod_json::UniqueValue::deserialize(d)?.0;
        let wire = match value.get("strategy").and_then(|v| v.as_str()) {
            Some("author-selected") => {
                Wire::Author(serde_json::from_value(value).map_err(serde::de::Error::custom)?)
            }
            _ => Wire::Screen(serde_json::from_value(value).map_err(serde::de::Error::custom)?),
        };
        Ok(match wire {
            Wire::Screen(w) => Self {
                levels: w.levels,
                hysteresis_ratio: w.hysteresis_ratio,
                author: None,
            },
            Wire::Author(w) => Self {
                levels: w
                    .levels
                    .iter()
                    .map(|l| RenderLodLevel {
                        geometry: l.geometry.clone(),
                        min_projected_diameter_pixels: 0.0,
                        geometric_error: 0.0,
                        resident: None,
                    })
                    .collect(),
                hysteresis_ratio: None,
                author: Some(AuthorSelection {
                    revision: w.revision,
                    levels: w.levels,
                    selected_levels: w.selected_levels,
                }),
            },
        })
    }
}

fn selected_indices<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<usize>, D::Error> {
    Vec::<f64>::deserialize(d)?
        .into_iter()
        .map(|n| {
            if n.is_finite() && (0.0..=7.0).contains(&n) && n.fract() == 0.0 {
                Ok(n as usize)
            } else {
                Err(serde::de::Error::custom("author-selected invalid index"))
            }
        })
        .collect()
}

impl Serialize for RenderLodProfile {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if let Some(a) = &self.author {
            AuthorWire {
                strategy: AuthorStrategy::Author,
                revision: a.revision,
                levels: a.levels.clone(),
                selected_levels: a.selected_levels.clone(),
            }
            .serialize(s)
        } else {
            ScreenWire {
                strategy: None,
                levels: self.levels.clone(),
                hysteresis_ratio: self.hysteresis_ratio,
            }
            .serialize(s)
        }
    }
}

pub(super) fn validate(profile: &RenderLodProfile) -> Result<(), String> {
    let a = profile.author.as_ref().expect("author profile");
    if !a.revision.is_finite()
        || a.revision < 0.0
        || a.revision > 9_007_199_254_740_991.0
        || a.revision.fract() != 0.0
    {
        return Err("author-selected revision must be a nonnegative safe integer".into());
    }
    if !(1..=8).contains(&a.levels.len()) || a.levels.len() != profile.levels.len() {
        return Err("author-selected must have 1-8 levels".into());
    }
    for (i, l) in a.levels.iter().enumerate() {
        if !l.distance.is_finite()
            || l.distance < 0.0
            || !l.hysteresis.is_finite()
            || !(0.0..=1.0).contains(&l.hysteresis)
            || (i > 0 && l.distance < a.levels[i - 1].distance)
            || l.geometry != profile.levels[i].geometry
            || !profile.levels[i].is_resident()
        {
            return Err("author-selected invalid level or nonresident geometry".into());
        }
    }
    if a.selected_levels.iter().any(|&i| i >= a.levels.len())
        || a.selected_levels.windows(2).any(|w| w[0] >= w[1])
    {
        return Err("author-selected indices must be in range and strictly increasing".into());
    }
    Ok(())
}
