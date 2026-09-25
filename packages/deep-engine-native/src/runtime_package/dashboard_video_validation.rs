use super::{
    DashboardPage, DashboardVideoDiagnostic, DashboardVideoMedia, RuntimePackageError, fail,
};
use std::collections::{HashMap, HashSet};

const REQUIRED: [&str; 5] = [
    "video-decoder",
    "frame-texture-update",
    "media-clock",
    "playback-controls",
    "seek",
];
const READY: [&str; 0] = [];
const AUDIO_BLOCKED: [&str; 1] = ["audio-output"];
const MEDIA_BYTES_LIMIT: usize = 32 * 1024 * 1024;

pub(super) fn validate(
    videos: &[DashboardVideoDiagnostic],
    media: &[DashboardVideoMedia],
    pages: &[DashboardPage],
) -> Result<(), RuntimePackageError> {
    if videos.is_empty() || videos.len() > 32 || media.len() > 32 {
        return fail("invalid dashboard video diagnostic budget");
    }
    let mut media_by_id = HashMap::new();
    let mut media_bytes_by_id = HashMap::new();
    let mut media_bytes = 0usize;
    for item in media {
        let bytes = crate::deep2d::runtime_base64::decode(&item.data_base64)
            .map_err(|error| RuntimePackageError(format!("dashboard video base64: {error}")))?;
        media_bytes = media_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| RuntimePackageError("dashboard video byte budget overflow".into()))?;
        if media_bytes > MEDIA_BYTES_LIMIT
            || item.byte_length != bytes.len()
            || item.revision != 1
            || item.mime != "video/mp4"
            || item.format != "mp4-isobmff"
            || crate::shader_package::hash::sha256(&bytes) != item.sha256
            || item.id != format!("media.{}", item.sha256)
            || media_by_id.insert(item.id.as_str(), item).is_some()
            || !is_mp4_isobmff(&bytes)
        {
            return fail("invalid content-addressed dashboard MP4 media");
        }
        media_bytes_by_id.insert(item.id.as_str(), bytes);
    }
    let nodes = pages
        .iter()
        .flat_map(|page| page.nodes.iter().map(|node| node.id.as_str()))
        .collect::<HashSet<_>>();
    let mut runtime_ids = HashSet::new();
    let mut source_ids = HashSet::new();
    let mut referenced_media = HashSet::new();
    for video in videos {
        let uri_valid = video.source.uri.as_ref().is_none_or(|uri| {
            !uri.is_empty() && uri.len() <= 2_048 && !uri.chars().any(char::is_control)
        });
        let expected_availability = if video.source.uri.is_some() {
            "external-unresolved"
        } else {
            "missing"
        };
        let unavailable_reason = if video.source.uri.is_some() {
            "native-video-runtime-unavailable"
        } else {
            "source-missing"
        };
        let packaged = video.source.packaged;
        let audio_ready = packaged
            && (video.playback.muted
                || video
                    .source
                    .resource_id
                    .as_deref()
                    .and_then(|id| media_bytes_by_id.get(id))
                    .is_some_and(|bytes| has_audio_track(bytes)));
        let (expected_status, expected_transport, expected_reason, expected_missing): (
            &str,
            &str,
            &str,
            &[&str],
        ) = if packaged && audio_ready {
            (
                "ready",
                if video.playback.autoplay {
                    "autoplay"
                } else {
                    "poster"
                },
                "native-video-runtime-ready",
                &READY,
            )
        } else if packaged {
            (
                "blocked",
                "unavailable",
                "native-video-audio-unavailable",
                &AUDIO_BLOCKED,
            )
        } else {
            ("blocked", "unavailable", unavailable_reason, &REQUIRED)
        };
        if !nodes.contains(video.node_id.as_str())
            || !runtime_ids.insert(video.node_id.as_str())
            || video.source_node_id.is_empty()
            || video.source_node_id.len() > 256
            || video.source_node_id.chars().any(char::is_control)
            || !source_ids.insert(video.source_node_id.as_str())
            || !uri_valid
            || if packaged {
                video.source.availability != "packaged"
                    || video
                        .source
                        .resource_id
                        .as_ref()
                        .is_none_or(|id| !media_by_id.contains_key(id.as_str()))
            } else {
                video.source.availability != expected_availability
                    || video.source.resource_id.is_some()
            }
            || !matches!(video.playback.fit.as_str(), "cover" | "contain" | "fill")
            || video.state.status != expected_status
            || video.state.transport != expected_transport
            || video.state.position_seconds != 0.0
            || video.state.duration_seconds.is_some()
            || video.state.reason != expected_reason
            || video.state.missing_capabilities.len() != expected_missing.len()
            || !video
                .state
                .missing_capabilities
                .iter()
                .zip(expected_missing.iter())
                .all(|(actual, expected)| actual == *expected)
        {
            return fail("invalid or falsely playable dashboard video diagnostic");
        }
        if let Some(id) = &video.source.resource_id {
            referenced_media.insert(id.as_str());
        }
    }
    if referenced_media.len() != media_by_id.len()
        || media_by_id.keys().any(|id| !referenced_media.contains(id))
    {
        return fail("packaged dashboard video media lacks a diagnostic owner");
    }
    Ok(())
}

pub(crate) fn is_mp4_isobmff(bytes: &[u8]) -> bool {
    if bytes.len() < 16 {
        return false;
    }
    let length = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
    if &bytes[4..8] != b"ftyp" || length < 16 || length > bytes.len() || !length.is_multiple_of(4) {
        return false;
    }
    let supported = |brand: &[u8]| matches!(brand, b"isom" | b"iso2" | b"mp41" | b"mp42");
    supported(&bytes[8..12])
        || (16..length)
            .step_by(4)
            .any(|offset| supported(&bytes[offset..offset + 4]))
}

fn has_audio_track(bytes: &[u8]) -> bool {
    const CONTAINERS: [&[u8; 4]; 10] = [
        b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf", b"mvex", b"moof", b"traf",
    ];
    fn walk(bytes: &[u8], start: usize, end: usize, depth: u8, found: &mut bool) -> bool {
        if depth > 12 {
            return false;
        }
        let mut offset = start;
        while offset + 8 <= end {
            let size32 = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
            let kind = &bytes[offset + 4..offset + 8];
            let (header, size) = if size32 == 1 {
                if offset + 16 > end {
                    return false;
                }
                let high = u64::from(u32::from_be_bytes(
                    bytes[offset + 8..offset + 12].try_into().unwrap(),
                ));
                let low = u64::from(u32::from_be_bytes(
                    bytes[offset + 12..offset + 16].try_into().unwrap(),
                ));
                (16usize, (high << 32) | low)
            } else if size32 == 0 {
                (8usize, (end - offset) as u64)
            } else {
                (8usize, u64::from(size32))
            };
            let Ok(size) = usize::try_from(size) else {
                return false;
            };
            if size < header || offset.checked_add(size).is_none_or(|value| value > end) {
                return false;
            }
            let content_start = offset + header;
            let content_end = offset + size;
            if kind == b"hdlr"
                && content_start + 12 <= content_end
                && &bytes[content_start + 8..content_start + 12] == b"soun"
            {
                *found = true;
            }
            if CONTAINERS
                .iter()
                .any(|container| kind == container.as_slice())
                && !walk(bytes, content_start, content_end, depth + 1, found)
            {
                return false;
            }
            offset = content_end;
        }
        offset == end
    }
    let mut found = false;
    walk(bytes, 0, bytes.len(), 0, &mut found) && found
}

#[cfg(test)]
mod tests {
    use super::has_audio_track;

    fn box4(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = u32::try_from(payload.len() + 8).unwrap();
        let mut value = Vec::with_capacity(size as usize);
        value.extend_from_slice(&size.to_be_bytes());
        value.extend_from_slice(kind);
        value.extend_from_slice(payload);
        value
    }

    fn join(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.iter().flat_map(|part| part.iter().copied()).collect()
    }

    #[test]
    fn audio_probe_distinguishes_soun_from_vide_and_keeps_valid_traversal_false() {
        let mut video_handler = vec![0; 12];
        video_handler[8..12].copy_from_slice(b"vide");
        let video = box4(
            b"moov",
            &box4(b"trak", &box4(b"mdia", &box4(b"hdlr", &video_handler))),
        );
        assert!(!has_audio_track(&video));

        let mut audio_handler = vec![0; 12];
        audio_handler[8..12].copy_from_slice(b"soun");
        let audio = box4(
            b"moov",
            &join(&[
                box4(b"trak", &box4(b"mdia", &box4(b"hdlr", &video_handler))),
                box4(b"trak", &box4(b"mdia", &box4(b"hdlr", &audio_handler))),
            ]),
        );
        assert!(has_audio_track(&audio));
    }
}
