//! D05/U05 foundation: pure text layout over UTF-8 without a shaping
//! engine. This module owns the parts of the text contract that do NOT
//! require font metrics or glyph rasterization: grapheme cluster boundaries
//! (cursor/selection granularity), simplified line breaking (CJK per-character
//! vs. space-delimited words) and width-driven line assembly. Shaping,
//! fallback fonts and bidi reordering stay explicitly out of scope until the
//! font-library dependency is approved.

/// A measured cluster: the byte range inside the source text plus its
/// measured advance. `advance` is supplied by the caller (font metrics or a
/// test stub) per cluster.
#[derive(Debug, Clone, PartialEq)]
pub struct Cluster {
    /// Byte offsets into the source string: [start, end).
    pub start: usize,
    pub end: usize,
    pub advance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    /// Byte range of this line in the source text (newline excluded).
    pub start: usize,
    pub end: usize,
    pub width: f64,
}

/// UAX #29 extended grapheme boundaries, shared with the existing shaping dependency.
pub fn grapheme_clusters(text: &str, advance_of: impl Fn(&str) -> f64) -> Vec<Cluster> {
    use unicode_segmentation::UnicodeSegmentation;
    text.grapheme_indices(true)
        .map(|(start, cluster)| Cluster {
            start,
            end: start + cluster.len(),
            advance: advance_of(cluster),
        })
        .collect()
}

/// Line-breaking decision (simplified UAX #14): break opportunities after
/// any cluster except — no break before closing punctuation, no break in
/// the middle of a word for non-CJK text (break at spaces/hyphens only),
/// and CJK ideographs break anywhere.
pub fn can_break_before(text: &str, byte_index: usize) -> bool {
    let bytes = text.as_bytes();
    if byte_index == 0 || byte_index >= bytes.len() {
        return false;
    }
    let previous = text[..byte_index].chars().next_back().unwrap_or(' ');
    let next = text[byte_index..].chars().next().unwrap_or(' ');
    // Never break directly before closing punctuation or comma-like marks.
    if matches!(
        next,
        ')' | ']' | '}' | ',' | '。' | '，' | '、' | '；' | '：' | '！' | '？' | '》'
    ) {
        return false;
    }
    // Never break after opening punctuation.
    if matches!(previous, '(' | '[' | '{' | '《') {
        return false;
    }
    // CJK ideographs and full-width kana break freely on both sides.
    if is_cjk(previous) || is_cjk(next) {
        return true;
    }
    // Latin scripts break at whitespace boundaries only.
    previous.is_whitespace() || next.is_whitespace()
}

fn is_cjk(ch: char) -> bool {
    matches!(ch, '\u{2E80}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{FF00}'..='\u{FFEF}'
        | '\u{20000}'..='\u{2FA1F}')
}

/// Assembles lines no wider than `max_width` from measured clusters. A
/// single cluster wider than the limit still occupies its own line
/// (no infinite loop, mirrors Canvas2D `maxWidth` semantics).
pub fn layout_lines(text: &str, max_width: f64, advance_of: impl Fn(&str) -> f64) -> Vec<TextLine> {
    let clusters = grapheme_clusters(text, &advance_of);
    let mut lines = Vec::new();
    let mut line_start = 0usize;
    let mut line_width = 0.0f64;
    // 换行位置同时记录可见宽度与已消费宽度，避免回退时漏掉后面的已量测簇。
    let mut last_break: Option<(usize, f64, f64)> = None;
    for cluster in &clusters {
        let cluster_end = cluster.end;
        let cluster_text = &text[cluster.start..cluster_end];
        if cluster_text.contains('\n') {
            lines.push(TextLine {
                start: line_start,
                end: cluster.start,
                width: line_width,
            });
            line_start = cluster_end;
            line_width = 0.0;
            last_break = None;
            continue;
        }
        let would_exceed = line_width > 0.0 && line_width + cluster.advance > max_width;
        if would_exceed {
            // Prefer the last break opportunity inside the line, if any.
            if let Some((break_at, break_width, consumed_width)) = last_break.take() {
                lines.push(TextLine {
                    start: line_start,
                    end: break_at,
                    width: break_width,
                });
                line_start = break_at;
                line_width -= consumed_width;
            }
            // 留下的长词加当前簇仍超宽时，在当前簇前强制断开。
            if line_start < cluster.start && line_width + cluster.advance > max_width {
                lines.push(TextLine {
                    start: line_start,
                    end: cluster.start,
                    width: line_width,
                });
                line_start = cluster.start;
                line_width = 0.0;
            }
        }
        line_width += cluster.advance;
        if can_break_before(text, cluster_end) {
            // Whitespace clusters end the word: the break sits after them and
            // the trailing space does not count toward the next line width.
            let is_ws = cluster_text.chars().all(char::is_whitespace);
            let width_before = if is_ws {
                line_width - cluster.advance
            } else {
                line_width
            };
            last_break = Some((cluster_end, width_before, line_width));
        }
    }
    if line_start < text.len() {
        lines.push(TextLine {
            start: line_start,
            end: text.len(),
            width: line_width,
        });
    } else if lines.is_empty() {
        lines.push(TextLine {
            start: 0,
            end: text.len(),
            width: 0.0,
        });
    }
    lines
}

#[cfg(test)]
#[path = "layout_wrap_tests.rs"]
mod wrap_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn monospace(advance: f64) -> impl Fn(&str) -> f64 {
        move |cluster: &str| {
            // Rough width model: CJK = 2 units, everything else = 1.
            if cluster.chars().any(is_cjk) {
                advance * 2.0
            } else {
                advance
            }
        }
    }

    #[test]
    fn clusters_keep_cjk_ascii_emoji_and_combining_intact() {
        let text = "a中\u{1F1E8}\u{1F1F3}\u{0301}b";
        let clusters = grapheme_clusters(text, |_| 1.0);
        let texts = clusters
            .iter()
            .map(|cluster| &text[cluster.start..cluster.end])
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec!["a", "中", "\u{1F1E8}\u{1F1F3}\u{0301}", "b"],
            "flag pair is one cluster and the combining mark attaches to it"
        );
    }

    #[test]
    fn cursor_positions_count_clusters_never_utf16_units() {
        // "👍" is 1 cluster but 2 UTF-16 code units: cursors must land on 2
        // positions (before/after), not 3.
        let text = "a👍b";
        let clusters = grapheme_clusters(text, |_| 1.0);
        assert_eq!(clusters.len(), 3);
        assert_eq!(clusters[1].start, 1);
        assert_eq!(clusters[1].end, 5, "4-byte emoji is one cursor stop");
    }

    #[test]
    fn cjk_breaks_per_character_latin_breaks_at_words() {
        assert!(can_break_before("中文测试", 3), "CJK breaks anywhere");
        assert!(can_break_before("hello world", 5), "after space");
        assert!(!can_break_before("hello world", 2), "mid-word is atomic");
        assert!(!can_break_before("a(b)", 2), "no break after opening paren");
        assert!(!can_break_before("a,b", 2), "no break before comma");
    }

    #[test]
    fn layout_respects_width_and_prefers_break_opportunities() {
        let lines = layout_lines("hello world foo", 60.0, monospace(10.0));
        assert!(
            lines.iter().all(|line| line.width <= 60.0),
            "every line respects max width: {lines:?}"
        );
        // "hello " + "world " + "foo" — break after spaces; the rendered
        // line keeps the trailing space byte range but width excludes it.
        assert_eq!(&"hello world foo"[lines[0].start..lines[0].end], "hello ");
        assert_eq!(lines[0].width, 50.0, "trailing space width excluded");
        assert_eq!(&"hello world foo"[lines[1].start..lines[1].end], "world ");
        assert_eq!(&"hello world foo"[lines[2].start..lines[2].end], "foo");

        // CJK: 5 chars × 20 = 100 wide; limit 60 → lines of 3 + 2.
        let cjk_lines = layout_lines("中文测试", 60.0, monospace(10.0));
        assert_eq!(cjk_lines.len(), 2);
        assert_eq!(&"中文测试"[cjk_lines[0].start..cjk_lines[0].end], "中文测");

        // Each over-wide cluster still gets its own line (no infinite loop,
        // no cluster splitting) — 4 over-wide chars → 4 one-char lines.
        let wide = layout_lines("WWWW", 10.0, |_| 100.0);
        assert_eq!(wide.len(), 4);
        assert!(wide.iter().all(|line| line.end - line.start == 1));
    }
}
