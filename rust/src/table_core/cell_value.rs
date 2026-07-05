//! Atomic cell values — `SPECIFICATION-NEXT.html` §4.1.
//!
//! The Flat Cell principle (§1): structure lives in the grid, so a cell holds
//! exactly one *atomic* value and never a nested collection. In the water
//! metaphor (Appendix A) a cell is a vessel, and a vessel holds one water: the
//! six variants of [`CellValue`] are the only things a vessel can contain.
//!
//! Numeric values reuse the exact-real continued-fraction kernel unchanged
//! (§4.2); this module adds no approximate numeric type. Equality and ordering
//! of scalars run under the comparison budget of §7.4.1 and surface the
//! agreed-prefix of §4.5.0, so an undecided lazy comparison yields the logical
//! Unknown (U) rather than a guessed Boolean.

use crate::types::continued_fraction::{CmpOutcome, ExactReal};
use crate::types::fraction::Fraction;
use std::sync::Arc;

/// Default partial-quotient budget for the bare relations (§7.4.1). Finite
/// (rational) continued fractions always decide regardless of the budget, so
/// this only bounds comparisons of lazy irrationals; it is chosen high enough
/// that distinct rationals — and every value in the admitted domain \(D\) of
/// §4.2.7 — always decide. The value is not part of observable semantics
/// (`COMPARE-WITHIN`, §7.4.2, is the only way to name a budget explicitly).
pub const DEFAULT_COMPARISON_BUDGET: usize = 1024;

/// Why a cell became NIL — the direct reason carried on a Bubble
/// (§4.5.0, §11.1). Reason identity is separate from NIL identity: all NIL
/// values are equal (§4.5.0), and `NIL?` (see [`CellValue::is_nil`]) must not
/// branch on the cause. This enum is the machine-readable reason surface;
/// human-readable text is non-canonical.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NilCause {
    /// Division by an exactly-zero divisor (§7.3, §11.1 Bubble).
    DivisionByZero,
    /// `SQRT` of a negative rational — a well-formed domain miss (§7.3).
    NegativeSqrt,
    /// Arithmetic, comparison, or logic reached a value of the wrong kind
    /// (e.g. a Text operand in a numeric aggregation) — §7.1, §7.3.
    TypeMismatch,
    /// A formula read an Empty cell where a value was required; blank is never
    /// silently coerced to zero (§4.6).
    EmptyCell,
    /// `TO-NUMBER` could not parse its Text operand (§7.6).
    ParseFailure,
    /// The cell exhausted its per-cell execution step budget (§6.4).
    StepBudgetExhausted,
    /// The cell lies on a dependency cycle (§9.4) — the "uphill channel" of
    /// Appendix A.
    ReferenceCycle,
    /// A dependent of a cell in the error state receives this (§11.1).
    UpstreamError,
    /// A `COND` with no satisfied clause and no else clause (§7.7).
    CondExhausted,
}

impl NilCause {
    /// Machine-readable protocol string, lower camel case (§4.5.0, §14.1).
    /// Stable across releases; the second authority tier depends on it.
    pub fn as_protocol_str(self) -> &'static str {
        match self {
            NilCause::DivisionByZero => "divisionByZero",
            NilCause::NegativeSqrt => "negativeSqrt",
            NilCause::TypeMismatch => "typeMismatch",
            NilCause::EmptyCell => "emptyCell",
            NilCause::ParseFailure => "parseFailure",
            NilCause::StepBudgetExhausted => "stepBudgetExhausted",
            NilCause::ReferenceCycle => "referenceCycle",
            NilCause::UpstreamError => "upstreamError",
            NilCause::CondExhausted => "condExhausted",
        }
    }
}

/// The result of comparing two present cell values for equality (§7.4). The
/// third case is the logical Unknown (U): a lazy continued-fraction comparison
/// that did not settle within the budget, carrying the agreed-prefix of
/// §4.5.0. Over the admitted domain \(D\) (§4.2.7) `Undecided` never arises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EqOutcome {
    /// The equality settled definitely.
    Definite(bool),
    /// The comparison budget was exhausted; `agreed_prefix` is the number of
    /// leading (nearest-integer) partial quotients that matched (§4.5.0).
    Undecided { agreed_prefix: usize },
}

/// An atomic cell value — the one thing a vessel may hold (§4.1).
///
/// This type deliberately does not implement `PartialEq`: value identity of
/// scalars requires a comparison budget for lazy operands (§7.4.1), so equality
/// is exposed through [`CellValue::value_eq`], which is honest about
/// undecidability, rather than through a structural `==` that would either lie
/// (comparing representations) or be unable to report U.
#[derive(Debug, Clone)]
pub enum CellValue {
    /// An exact real number (§4.2), backed by a continued fraction.
    Scalar(ExactReal),
    /// A definite logical truth value (§4.3). Distinct from any number:
    /// `TRUE` is not the scalar `1`.
    Bool(bool),
    /// An immutable Unicode string (§4.4).
    Text(Arc<str>),
    /// The reason-carrying absence of a value (§4.5). `None` is a bare/literal
    /// NIL with no reason (§4.5.0); a Bubble carries `Some(cause)`.
    Nil(Option<NilCause>),
    /// The logical-undecidability truth value U, storable as a cell result
    /// (§4.3). `agreed_prefix` is diagnostic context only (§4.5.0).
    Unknown { agreed_prefix: Option<usize> },
    /// The deliberate blankness of an untouched cell (§4.6). Distinct from NIL:
    /// aggregation flows past Empty, while treating it as a value is refused.
    Empty,
}

impl CellValue {
    // -- constructors -------------------------------------------------------

    /// An exact integer scalar.
    pub fn integer(n: i64) -> Self {
        CellValue::Scalar(ExactReal::from_integer(n))
    }

    /// An exact rational scalar.
    pub fn rational(f: Fraction) -> Self {
        CellValue::Scalar(ExactReal::from_fraction(f))
    }

    /// A scalar from an arbitrary exact real (rational, √-rational, or Gosper
    /// transform).
    pub fn scalar(x: ExactReal) -> Self {
        CellValue::Scalar(x)
    }

    /// A Boolean truth value.
    pub fn boolean(b: bool) -> Self {
        CellValue::Bool(b)
    }

    /// A Text value.
    pub fn text(s: impl Into<Arc<str>>) -> Self {
        CellValue::Text(s.into())
    }

    /// A Bubble: NIL carrying its direct reason (§4.5.0).
    pub fn nil(cause: NilCause) -> Self {
        CellValue::Nil(Some(cause))
    }

    /// A bare NIL with no reason (§4.5.0).
    pub fn bare_nil() -> Self {
        CellValue::Nil(None)
    }

    /// The logical Unknown (U), optionally carrying an agreed-prefix (§4.5.0).
    pub fn unknown(agreed_prefix: Option<usize>) -> Self {
        CellValue::Unknown { agreed_prefix }
    }

    /// The Empty cell state (§4.6).
    pub fn empty() -> Self {
        CellValue::Empty
    }

    // -- kind predicates ----------------------------------------------------

    /// True iff this is a Scalar.
    pub fn is_scalar(&self) -> bool {
        matches!(self, CellValue::Scalar(_))
    }

    /// True iff this is a Boolean.
    pub fn is_bool(&self) -> bool {
        matches!(self, CellValue::Bool(_))
    }

    /// True iff this is Text.
    pub fn is_text(&self) -> bool {
        matches!(self, CellValue::Text(_))
    }

    /// `NIL?` (§7.7): true iff this is a NIL. Notably `false` for Empty
    /// (§4.6) and for Unknown (§4.5.2) — none of those are absence-of-value.
    pub fn is_nil(&self) -> bool {
        matches!(self, CellValue::Nil(_))
    }

    /// `UNKNOWN?` (§7.7): true iff this is the logical Unknown (U).
    pub fn is_unknown(&self) -> bool {
        matches!(self, CellValue::Unknown { .. })
    }

    /// `EMPTY?` (§7.7): true iff this is the Empty cell state (§4.6).
    pub fn is_empty(&self) -> bool {
        matches!(self, CellValue::Empty)
    }

    /// True iff this carries a definite value of a data kind
    /// (Scalar/Bool/Text) — i.e. not NIL, Unknown, or Empty. This is the set
    /// of operands over which the arithmetic and text words are defined.
    pub fn is_present(&self) -> bool {
        matches!(
            self,
            CellValue::Scalar(_) | CellValue::Bool(_) | CellValue::Text(_)
        )
    }

    // -- accessors ----------------------------------------------------------

    /// The scalar, if this is one.
    pub fn as_scalar(&self) -> Option<&ExactReal> {
        match self {
            CellValue::Scalar(x) => Some(x),
            _ => None,
        }
    }

    /// The Boolean, if this is one.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            CellValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The text, if this is Text.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            CellValue::Text(s) => Some(s),
            _ => None,
        }
    }

    /// The NIL cause, if this is a NIL carrying one. This is a diagnostic
    /// accessor (`NIL-REASON`, §4.5.0); ordinary code uses [`is_nil`] and must
    /// not branch on the cause.
    ///
    /// [`is_nil`]: CellValue::is_nil
    pub fn nil_cause(&self) -> Option<NilCause> {
        match self {
            CellValue::Nil(cause) => *cause,
            _ => None,
        }
    }

    // -- comparison (§7.4) --------------------------------------------------

    /// Value equality (`EQ`, §7.4), total across kinds and budget-honest for
    /// scalars. Rules:
    ///
    /// - two Scalars compare under `budget`, yielding `Definite` on a settled
    ///   order or `Undecided` (U) when the budget is exhausted (§7.4.1);
    /// - two Booleans / two Texts compare structurally;
    /// - two NILs are equal regardless of cause (§4.5.0), and two Empties are
    ///   equal;
    /// - any comparison involving Unknown is itself `Undecided` (a value whose
    ///   truth is unknown cannot be equated definitely);
    /// - values of different kinds are definitely unequal — in particular
    ///   `TRUE 1 EQ` is `false` (§4.3).
    ///
    /// The word layer applies NIL/Empty passthrough (§4.5.1, §7.1) around this
    /// where required; this method itself is total and never panics.
    pub fn value_eq(&self, other: &Self, budget: usize) -> EqOutcome {
        use CellValue::*;
        match (self, other) {
            (Scalar(a), Scalar(b)) => match a.cmp_with_budget_tracked(b, budget) {
                CmpOutcome::Decided(order) => {
                    EqOutcome::Definite(order == std::cmp::Ordering::Equal)
                }
                CmpOutcome::Undecided { agreed_prefix } => EqOutcome::Undecided { agreed_prefix },
            },
            (Bool(a), Bool(b)) => EqOutcome::Definite(a == b),
            (Text(a), Text(b)) => EqOutcome::Definite(a == b),
            (Empty, Empty) => EqOutcome::Definite(true),
            (Nil(_), Nil(_)) => EqOutcome::Definite(true),
            (Unknown { .. }, _) | (_, Unknown { .. }) => EqOutcome::Undecided { agreed_prefix: 0 },
            _ => EqOutcome::Definite(false),
        }
    }

    /// Numeric ordering of two scalars under `budget` (`LT`/`LTE`/`GT`/`GTE`,
    /// §7.4). Returns `None` unless both operands are Scalars — ordering across
    /// value kinds is a domain miss the word layer projects to a Bubble
    /// (`typeMismatch`). When both are Scalars, the [`CmpOutcome`] is
    /// `Decided(ordering)` or `Undecided { agreed_prefix }` (U, §7.4.1).
    pub fn scalar_order(&self, other: &Self, budget: usize) -> Option<CmpOutcome> {
        match (self, other) {
            (CellValue::Scalar(a), CellValue::Scalar(b)) => {
                Some(a.cmp_with_budget_tracked(b, budget))
            }
            _ => None,
        }
    }

    // -- display (non-canonical, §4.2.3 / §12.2) ----------------------------

    /// A non-canonical, human/AI-readable rendering for diagnostics and tests.
    /// Rationals render as reduced `numerator/denominator` (integers bare)
    /// under the `RawNumber` role; lazy scalars render as the bracket
    /// continued-fraction form of §4.2.3. This string must never be parsed
    /// back as a value (§3.4).
    pub fn describe(&self) -> String {
        match self {
            CellValue::Scalar(x) => describe_scalar(x),
            CellValue::Bool(true) => "TRUE".to_string(),
            CellValue::Bool(false) => "FALSE".to_string(),
            CellValue::Text(s) => s.to_string(),
            CellValue::Nil(_) => "NIL".to_string(),
            CellValue::Unknown { .. } => "?".to_string(),
            CellValue::Empty => String::new(),
        }
    }
}

/// Render a scalar for [`CellValue::describe`]. Rationals use the `RawNumber`
/// role; other exact reals use the bracket continued-fraction form of §4.2.3
/// with a small display budget, terminated by `...` when more terms remain.
fn describe_scalar(x: &ExactReal) -> String {
    if let Some(f) = x.to_fraction() {
        let den = f.denominator();
        if den == num_bigint::BigInt::from(1) {
            return f.numerator().to_string();
        }
        return format!("{}/{}", f.numerator(), den);
    }

    // Lazy (irrational) scalar: bracket CF form, [ a0 ; a1 , a2 , ... ].
    const DISPLAY_TERMS: usize = 8;
    let terms = x.partial_quotients_bounded(DISPLAY_TERMS + 1);
    if terms.is_empty() {
        return "[ ]".to_string();
    }
    let mut out = format!("[ {}", terms[0]);
    let shown = terms.len().min(DISPLAY_TERMS);
    for (i, term) in terms.iter().take(shown).enumerate().skip(1) {
        out.push_str(if i == 1 { " ; " } else { " , " });
        out.push_str(&term.to_string());
    }
    if terms.len() > DISPLAY_TERMS {
        out.push_str(if shown <= 1 { " ; ..." } else { " , ..." });
    }
    out.push_str(" ]");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use num_bigint::BigInt;

    fn frac(n: i64, d: i64) -> Fraction {
        Fraction::new(BigInt::from(n), BigInt::from(d))
    }

    #[test]
    fn empty_is_not_nil_and_nil_is_not_empty() {
        // §4.6: Empty and NIL are distinct; NIL? of Empty is false.
        let empty = CellValue::empty();
        assert!(empty.is_empty());
        assert!(!empty.is_nil());

        let bubble = CellValue::nil(NilCause::DivisionByZero);
        assert!(bubble.is_nil());
        assert!(!bubble.is_empty());
        assert_eq!(bubble.nil_cause(), Some(NilCause::DivisionByZero));
    }

    #[test]
    fn nil_cause_protocol_strings_are_lower_camel_case() {
        // §4.5.0 / §14.1: machine-readable reason surface.
        assert_eq!(NilCause::DivisionByZero.as_protocol_str(), "divisionByZero");
        assert_eq!(NilCause::EmptyCell.as_protocol_str(), "emptyCell");
        assert_eq!(NilCause::ReferenceCycle.as_protocol_str(), "referenceCycle");
    }

    #[test]
    fn thirds_sum_to_one_exactly() {
        // §4.2: exact rational arithmetic, no floating point. 1/3+1/3+1/3 = 1.
        let third = ExactReal::from_fraction(frac(1, 3));
        let sum = third.add(&third).add(&third);
        let one = CellValue::integer(1);
        assert_eq!(
            CellValue::scalar(sum).value_eq(&one, DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Definite(true)
        );
    }

    #[test]
    fn equal_square_roots_decide_without_budget_exhaustion() {
        // §4.2.7 / §7.4: √2 = √2 decides definitely (algebraic short-circuit),
        // even though the operand is a lazy continued fraction.
        let a = CellValue::scalar(ExactReal::from_sqrt_rational(frac(2, 1)).unwrap());
        let b = CellValue::scalar(ExactReal::from_sqrt_rational(frac(2, 1)).unwrap());
        assert_eq!(
            a.value_eq(&b, DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Definite(true)
        );
        assert!(a.as_scalar().is_some_and(|x| !x.is_rational()));
    }

    #[test]
    fn boolean_is_not_a_number() {
        // §4.3: TRUE is not the scalar 1, so TRUE 1 EQ is false.
        let t = CellValue::boolean(true);
        let one = CellValue::integer(1);
        assert_eq!(
            t.value_eq(&one, DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Definite(false)
        );
    }

    #[test]
    fn text_equality_is_codepoint_equality() {
        // §4.4.
        let a = CellValue::text("hello");
        let b = CellValue::text("hello");
        let c = CellValue::text("world");
        assert_eq!(
            a.value_eq(&b, DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Definite(true)
        );
        assert_eq!(
            a.value_eq(&c, DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Definite(false)
        );
    }

    #[test]
    fn all_nils_are_equal_regardless_of_cause() {
        // §4.5.0: equality treats all NIL uniformly.
        let a = CellValue::nil(NilCause::DivisionByZero);
        let b = CellValue::nil(NilCause::EmptyCell);
        assert_eq!(
            a.value_eq(&b, DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Definite(true)
        );
    }

    #[test]
    fn unknown_never_equates_definitely() {
        // §4.3 / §7.4.3: U is storable and never yields a definite equality.
        let u = CellValue::unknown(Some(3));
        assert!(u.is_unknown());
        assert_eq!(
            u.value_eq(&CellValue::integer(1), DEFAULT_COMPARISON_BUDGET),
            EqOutcome::Undecided { agreed_prefix: 0 }
        );
    }

    #[test]
    fn scalar_ordering_decides_for_rationals() {
        // §7.4: rationals are totally ordered and always decide.
        use std::cmp::Ordering;
        let two = CellValue::integer(2);
        let five = CellValue::integer(5);
        match two.scalar_order(&five, DEFAULT_COMPARISON_BUDGET) {
            Some(CmpOutcome::Decided(Ordering::Less)) => {}
            other => panic!("expected Decided(Less), got {other:?}"),
        }
        // Ordering across kinds is not defined at the value layer.
        assert!(two
            .scalar_order(&CellValue::text("x"), DEFAULT_COMPARISON_BUDGET)
            .is_none());
    }

    #[test]
    fn describe_renders_raw_number_and_bracket_cf() {
        assert_eq!(CellValue::integer(3).describe(), "3");
        assert_eq!(CellValue::rational(frac(3, 4)).describe(), "3/4");
        assert_eq!(CellValue::boolean(false).describe(), "FALSE");
        assert_eq!(CellValue::empty().describe(), "");
        assert_eq!(CellValue::nil(NilCause::DivisionByZero).describe(), "NIL");

        // √2 = [ 1 ; 2 , 2 , 2 , ... ] in the bracket form of §4.2.3.
        let root2 = CellValue::scalar(ExactReal::from_sqrt_rational(frac(2, 1)).unwrap());
        let shown = root2.describe();
        assert!(shown.starts_with("[ 1 ; 2"), "got {shown}");
        assert!(shown.ends_with("... ]"), "got {shown}");
    }
}
