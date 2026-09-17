//! Independent source witnesses for clamped, closed, non-rational B-curves.
//! Basis-function summation deliberately does not call cad-ir/cad-xt evaluators.
use std::collections::BTreeMap;
use xt_parser::{
    entity::{Entities, FieldVal, RawEntity},
    schema as xt,
};

fn integer(fields: &[FieldVal], slot: usize) -> Option<usize> {
    match fields.get(slot)? {
        FieldVal::Short(v) => usize::try_from(*v).ok(),
        FieldVal::Int(v) => usize::try_from(*v).ok(),
        _ => None,
    }
}
fn target<'a>(
    fields: &[FieldVal],
    slot: usize,
    index: &BTreeMap<usize, &'a RawEntity>,
    kind: u16,
) -> Option<&'a RawEntity> {
    let FieldVal::Ptr(id) = fields.get(slot)? else {
        return None;
    };
    index.get(id).copied().filter(|r| r.type_id == kind)
}

pub fn source_points(
    e: &Entities,
    curve: &RawEntity,
    index: &BTreeMap<usize, &RawEntity>,
) -> Option<Vec<[f64; 3]>> {
    if curve.type_id != xt::B_CURVE {
        return None;
    }
    let nurbs = target(e.fields(curve), 7, index, xt::NURBS_CURVE)?;
    let f = e.fields(nurbs);
    if f.len() != 12
        || !matches!(f[6], FieldVal::Bool(true))
        || !matches!(f[7], FieldVal::Bool(false))
        || integer(f, 2)? != 3
    {
        return None;
    }
    let (degree, count, knot_count) = (integer(f, 0)?, integer(f, 1)?, integer(f, 3)?);
    if count > 4096 || knot_count > 4096 {
        return None;
    }
    let poles = e.var_f64(target(f, 9, index, xt::BSPLINE_VERTICES)?);
    let multiplicity = e.var_i16(target(f, 10, index, xt::KNOT_MULT)?);
    let values = e.var_f64(target(f, 11, index, xt::KNOT_SET)?);
    if poles.len() != count.checked_mul(3)?
        || values.len() != knot_count
        || multiplicity.len() != knot_count
    {
        return None;
    }
    let mut knots = Vec::new();
    for (&value, &times) in values.iter().zip(multiplicity) {
        if times <= 0 || times as usize > degree + 1 || knots.len() + times as usize > 8192 {
            return None;
        }
        knots.extend(std::iter::repeat_n(value, times as usize));
    }
    let control: Vec<_> = poles.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    closed_samples(degree, &control, &knots)
}

fn evaluate(degree: usize, control: &[[f64; 3]], knots: &[f64], t: f64) -> [f64; 3] {
    if t == knots[control.len()] {
        return *control.last().unwrap();
    }
    let mut basis: Vec<_> = knots
        .windows(2)
        .map(|w| if w[0] <= t && t < w[1] { 1.0 } else { 0.0 })
        .collect();
    for p in 1..=degree {
        for i in 0..basis.len() - p {
            let left = knots[i + p] - knots[i];
            let right = knots[i + p + 1] - knots[i + 1];
            basis[i] = if left > 0.0 {
                (t - knots[i]) * basis[i] / left
            } else {
                0.0
            } + if right > 0.0 {
                (knots[i + p + 1] - t) * basis[i + 1] / right
            } else {
                0.0
            };
        }
    }
    let mut point = [0.0; 3];
    for (pole, weight) in control.iter().zip(basis) {
        for axis in 0..3 {
            point[axis] += pole[axis] * weight;
        }
    }
    point
}

fn closed_samples(degree: usize, control: &[[f64; 3]], knots: &[f64]) -> Option<Vec<[f64; 3]>> {
    if !(1..=8).contains(&degree)
        || control.len() <= degree
        || knots.len() != control.len() + degree + 1
        || !control.iter().flatten().chain(knots).all(|x| x.is_finite())
        || knots.windows(2).any(|w| w[1] < w[0])
    {
        return None;
    }
    let lo = knots[degree];
    let hi = knots[control.len()];
    if !(hi > lo)
        || knots[..=degree].iter().any(|x| *x != lo)
        || knots[control.len()..].iter().any(|x| *x != hi)
    {
        return None;
    }
    let first = control[0];
    let last = *control.last()?;
    if first
        .iter()
        .zip(last)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f64>()
        .sqrt()
        > 1e-10
    {
        return None;
    }
    let spans: Vec<_> = knots[degree..=control.len()]
        .windows(2)
        .filter(|w| w[1] > w[0])
        .collect();
    if spans.len() > 512 {
        return None;
    }
    let mut result = Vec::new();
    for span in spans {
        for k in 0..8 {
            let t = span[0] + (span[1] - span[0]) * k as f64 / 8.0;
            result.push(evaluate(degree, control, knots, t).map(|x| x * 1000.0));
        }
    }
    result.push(last.map(|x| x * 1000.0));
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cubic_basis_matches_bernstein_and_millimetres() {
        let p = [
            [0.0, 0.0, 0.0],
            [0.001, 0.002, 0.0],
            [0.002, -0.001, 0.0],
            [0.0, 0.0, 0.0],
        ];
        let k = [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        let samples = closed_samples(3, &p, &k).unwrap();
        assert_eq!(samples.len(), 9);
        for (actual, expected) in samples[4].iter().zip([1.125, 0.375, 0.0]) {
            assert!((actual - expected).abs() < 1e-12);
        }
        assert_eq!(samples.first(), samples.last());
    }
    #[test]
    fn nonuniform_repeated_knots_keep_every_span_endpoint() {
        let p = [
            [0.0, 0.0, 0.0],
            [0.001, 0.0, 0.0],
            [0.001, 0.002, 0.0],
            [0.0, 0.0, 0.0],
        ];
        let k = [0.0, 0.0, 0.2, 0.7, 1.0, 1.0];
        let samples = closed_samples(1, &p, &k).unwrap();
        assert_eq!(samples.len(), 25);
        assert_eq!(samples[8], [1.0, 0.0, 0.0]);
        assert_eq!(samples[16], [1.0, 2.0, 0.0]);
    }
    #[test]
    fn open_nonfinite_unclamped_and_invalid_knots_are_rejected() {
        let p = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]];
        assert!(closed_samples(1, &p, &[0.0, 0.0, 0.5, 1.0, 1.0]).is_some());
        let mut open = p;
        open[2][0] = 0.01;
        assert!(closed_samples(1, &open, &[0.0, 0.0, 0.5, 1.0, 1.0]).is_none());
        assert!(closed_samples(1, &p, &[-1.0, 0.0, 0.5, 1.0, 2.0]).is_none());
        assert!(closed_samples(1, &p, &[0.0, 0.0, 0.5, 0.4, 0.4]).is_none());
        assert!(closed_samples(1, &p, &[0.0, 0.0, f64::NAN, 1.0, 1.0]).is_none());
        assert!(closed_samples(0, &p, &[]).is_none());
    }
}
