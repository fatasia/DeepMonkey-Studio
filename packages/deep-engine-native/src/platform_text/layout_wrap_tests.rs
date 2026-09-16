use super::*;

#[test]
fn soft_wrap_carries_already_measured_tail_into_the_next_line() {
    let text = "aa bbbb";
    let lines = layout_lines(text, 4.0, |_| 1.0);
    assert_eq!(
        lines,
        vec![
            TextLine {
                start: 0,
                end: 3,
                width: 2.0
            },
            TextLine {
                start: 3,
                end: 7,
                width: 4.0
            },
        ]
    );
}

#[test]
fn wrapped_long_word_still_obeys_width_after_carrying_tail() {
    let text = "aa bbbbbbb";
    let lines = layout_lines(text, 4.0, |_| 1.0);
    let measured: Vec<_> = lines
        .iter()
        .map(|line| (&text[line.start..line.end], line.width))
        .collect();
    assert_eq!(measured, vec![("aa ", 2.0), ("bbbb", 4.0), ("bbb", 3.0)]);
}

#[test]
fn hard_break_is_processed_before_width_overflow() {
    for text in ["abc\nx", "abc\r\nx"] {
        let lines = layout_lines(text, 3.0, |_| 1.0);
        assert_eq!(lines.len(), 2);
        assert_eq!(&text[lines[0].start..lines[0].end], "abc");
        assert_eq!(lines[0].width, 3.0);
        assert_eq!(&text[lines[1].start..lines[1].end], "x");
        assert_eq!(lines[1].width, 1.0);
    }
}

#[test]
fn tail_carry_preserves_variable_advances_and_cluster_boundaries() {
    let text = "a 👩‍🔬e\u{0301}xx";
    let advance = |cluster: &str| if cluster == "👩‍🔬" { 2.0 } else { 1.0 };
    let lines = layout_lines(text, 4.0, advance);
    let measured: Vec<_> = lines
        .iter()
        .map(|line| (&text[line.start..line.end], line.width))
        .collect();
    assert_eq!(
        measured,
        vec![("a ", 1.0), ("👩‍🔬e\u{0301}x", 4.0), ("x", 1.0)]
    );
    let bounds: Vec<_> = grapheme_clusters(text, advance)
        .iter()
        .map(|cluster| cluster.end)
        .collect();
    for line in lines {
        assert!(line.start == 0 || bounds.contains(&line.start));
        assert!(bounds.contains(&line.end));
    }
}

#[test]
fn fitting_prefix_and_overwide_cluster_each_keep_their_measured_width() {
    let text = "a Wz";
    let lines = layout_lines(text, 3.0, |cluster| if cluster == "W" { 10.0 } else { 1.0 });
    let measured: Vec<_> = lines
        .iter()
        .map(|line| (&text[line.start..line.end], line.width))
        .collect();
    assert_eq!(measured, vec![("a ", 1.0), ("W", 10.0), ("z", 1.0)]);
}
