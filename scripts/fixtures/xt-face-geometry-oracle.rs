//! Raw geometry witnesses; deliberately links xt-parser only, never cad-xt.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use xt_parser::{
    entity::{Entities, FieldVal, RawEntity},
    schema as xt,
};

fn ptr(e: &Entities, r: &RawEntity, slot: usize) -> usize {
    match e.fields(r).get(slot) {
        Some(FieldVal::Ptr(v)) => *v,
        _ => panic!("invalid pointer"),
    }
}
fn vector(e: &Entities, r: &RawEntity, slot: usize) -> Option<[f64; 3]> {
    match e.fields(r).get(slot) {
        Some(FieldVal::Vec3(v)) if v.iter().all(|x| x.is_finite()) => Some(**v),
        _ => None,
    }
}
fn number(e: &Entities, r: &RawEntity, slot: usize) -> Option<f64> {
    match e.fields(r).get(slot) {
        Some(FieldVal::Float(v)) if v.is_finite() => Some(*v),
        _ => None,
    }
}
fn audit(path: &Path) {
    let bytes = std::fs::read(path).unwrap();
    assert!(bytes.len() <= 64 * 1024 * 1024);
    let count = bytes.len();
    let file = xt_parser::parse_raw(&xt_parser::decode(bytes)).unwrap();
    assert!(file.truncated.is_none());
    let e = &file.entities;
    let index: BTreeMap<_, _> = e.iter().map(|r| (r.index, r)).collect();
    assert_eq!(index.len(), e.len());
    let mut faces = Vec::new();
    for face in e.iter().filter(|r| r.type_id == xt::FACE) {
        assert_eq!(e.fields(face).len(), 14);
        let shell = index[&ptr(e, face, 6)];
        assert_eq!(shell.type_id, xt::SHELL);
        let region = index[&ptr(e, shell, 7)];
        assert_eq!(region.type_id, xt::REGION);
        let body = ptr(e, region, 2);
        let mut points = Vec::new();
        let mut loop_id = ptr(e, face, 5);
        let mut loops = BTreeSet::new();
        while loop_id != 0 {
            assert!(loops.insert(loop_id), "LOOP cycle");
            let lp = index[&loop_id];
            assert_eq!(lp.type_id, xt::LOOP);
            assert_eq!(ptr(e, lp, 3), face.index);
            let head = ptr(e, lp, 2);
            let mut fin_id = head;
            let mut fins = BTreeSet::new();
            while fin_id != 0 {
                if !fins.insert(fin_id) {
                    assert_eq!(fin_id, head);
                    break;
                }
                let fin = index[&fin_id];
                assert_eq!(fin.type_id, xt::FIN);
                let shift = match e.fields(fin).len() {
                    9 => 1,
                    10 => 0,
                    _ => panic!("FIN layout"),
                };
                assert_eq!(ptr(e, fin, 1 - shift), loop_id);
                let v = ptr(e, fin, 4 - shift);
                if v != 0 {
                    let vertex = index[&v];
                    assert_eq!(vertex.type_id, xt::VERTEX);
                    let point = index[&ptr(e, vertex, 5)];
                    assert_eq!(point.type_id, xt::POINT);
                    points.push(
                        vector(e, point, 5)
                            .expect("finite point")
                            .map(|x| x * 1000.0),
                    );
                }
                fin_id = ptr(e, fin, 2 - shift);
            }
            loop_id = ptr(e, lp, 4);
        }
        let surface_id = ptr(e, face, 7);
        let surface=index.get(&surface_id).and_then(|r| {
            let origin=vector(e,r,7)?.map(|x|x*1000.0);
            match r.type_id {
                xt::PLANE => Some(serde_json::json!({"kind":"plane","origin":origin,"axis":vector(e,r,8)?})),
                xt::CYLINDER => Some(serde_json::json!({"kind":"cylinder","origin":origin,"axis":vector(e,r,8)?,"radius":number(e,r,9)?*1000.0})),
                xt::SPHERE => Some(serde_json::json!({"kind":"sphere","origin":origin,"radius":number(e,r,8)?*1000.0})),
                xt::TORUS => {
                    let major=number(e,r,9)?*1000.0;
                    let minor=number(e,r,10)?*1000.0;
                    // Only ring tori: horn/spindle surfaces need a separate branch contract.
                    if !(minor>0.0 && major>minor) { return None; }
                    Some(serde_json::json!({"kind":"torus","origin":origin,"axis":vector(e,r,8)?,"majorRadius":major,"radius":minor}))
                },
                _ => None,
            }
        });
        points.sort_by(|a, b| a.partial_cmp(b).unwrap());
        points.dedup();
        faces.push(serde_json::json!({"body":body.to_string(),"face":face.index.to_string(),"points":points,"surface":surface}));
    }
    println!(
        "{}",
        serde_json::json!({"source":path,"sourceBytes":count,"space":"source-local-mm","faces":faces})
    );
}
fn visit(path: &Path, count: &mut usize) {
    let metadata = std::fs::symlink_metadata(path).unwrap();
    assert!(!metadata.file_type().is_symlink());
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).unwrap() {
            visit(&entry.unwrap().path(), count)
        }
        return;
    }
    if !path
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("x_t"))
    {
        return;
    }
    *count += 1;
    assert!(*count <= 10000);
    audit(path);
}
fn main() {
    let root = std::env::args().nth(1).expect("expected corpus");
    let mut n = 0;
    visit(Path::new(&root), &mut n);
    assert!(n > 0);
}
