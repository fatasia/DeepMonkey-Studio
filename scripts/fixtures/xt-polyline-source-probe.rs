//! Read selected raw curve chains without linking the geometry lowering.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use xt_parser::{entity::FieldVal, schema as xt};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!(args.len() > 1, "usage: probe file curve-handle...");
    let bytes = std::fs::read(&args[0]).unwrap();
    assert!(bytes.len() <= 64 * 1024 * 1024);
    let file = xt_parser::parse_raw(&xt_parser::decode(bytes)).unwrap();
    assert!(file.truncated.is_none());
    let entities = &file.entities;
    let index: BTreeMap<_, _> = entities.iter().map(|e| (e.index, e)).collect();
    let mut queue: VecDeque<usize> = args[1..].iter().map(|x| x.parse().unwrap()).collect();
    let mut seen = BTreeSet::new();
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        assert!(seen.len() <= 100);
        let e = index[&id];
        let fields = entities.fields(e);
        let slots: &[usize] = match e.type_id {
            xt::TRIMMED_CURVE => &[7],
            xt::SP_CURVE | xt::INTERSECTION => &[7, 8],
            _ => &[],
        };
        for slot in slots {
            match fields.get(*slot) {
                Some(FieldVal::Ptr(id)) if *id != 0 => queue.push_back(*id),
                _ => panic!("missing curve reference"),
            }
        }
        if e.type_id == xt::INTERSECTION {
            for field in entities.extra(e) {
                if let FieldVal::Ptr(id) = field {
                    if *id != 0 {
                        queue.push_back(*id);
                    }
                }
            }
        }
        println!(
            "{}",
            serde_json::json!({"handle":id,"type":e.type_id,
            "fields":fields.iter().map(|x|format!("{x:?}")).collect::<Vec<_>>(),
            "extra":format!("{:?}",entities.extra(e)),
            "chartValues":if e.type_id==xt::CHART {entities.var_f64(e).to_vec()}else{vec![]}})
        );
    }
}
