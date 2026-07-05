//! MC/DC test suite for `crate::types::fraction`.

// AQ-VER-001: Fraction MC/DC tests for QL-A boolean decisions.
//
// Scope: numeric core (`Fraction`) — boolean decisions whose
// independent atomic conditions can each cause an incorrect
// arithmetic or comparison result if mis-evaluated.
//
// Each submodule below documents:
//   * DUT (decision under test) — file:line and the boolean expression
//   * Conditions — atomic predicates A, B, ...
//   * MC/DC table — pairs of rows that demonstrate each condition
//     independently flipping the outcome
//
// Trace: docs/quality/TRACEABILITY_MATRIX.md, requirement AQ-REQ-001.

#![cfg(test)]

use crate::types::fraction::Fraction;
use num_bigint::BigInt;
use std::str::FromStr;

fn small(n: i64, d: i64) -> Fraction {
    Fraction::new(BigInt::from(n), BigInt::from(d))
}

fn big_int(n: i64) -> Fraction {
    let big = BigInt::from(i64::MAX) * BigInt::from(2i64) + BigInt::from(n);
    Fraction::new(big, BigInt::from(1))
}

// AQ-VER-001-A
// DUT: rust/src/types/fraction.rs:58-60 in `impl PartialEq for Fraction`
//
//     if self.is_nil() || other.is_nil() {
//         return self.is_nil() && other.is_nil();
//     }
//
// Conditions:
//   A = self.is_nil()
//   B = other.is_nil()
//
// MC/DC for A||B (entry guard):
//   row 1: (A=T, B=F) -> guard taken
//   row 2: (A=F, B=T) -> guard taken
//   row 3: (A=F, B=F) -> guard skipped
//   Pair (1,3) shows A independently flips outcome (B held F).
//   Pair (2,3) shows B independently flips outcome (A held F).
//
// MC/DC for A&&B (returned value when guard taken):
//   row 4: (A=T, B=T) -> true
//   row 5: (A=T, B=F) -> false
//   row 6: (A=F, B=T) -> false
//   Pair (4,5) shows B independently flips outcome (A held T).
//   Pair (4,6) shows A independently flips outcome (B held T).
mod nil_equality_guard {
    use super::*;

    #[test]
    fn aq_ver_001_a_row1_self_nil_other_nonnil_guard_taken_returns_false() {
        // (A=T, B=F): guard taken, inner A&&B = false -> not equal.
        let lhs = Fraction::nil();
        let rhs = small(1, 1);
        assert_ne!(lhs, rhs, "nil and non-nil must not be equal");
    }

    #[test]
    fn aq_ver_001_a_row2_other_nil_self_nonnil_guard_taken_returns_false() {
        // (A=F, B=T): guard taken, inner A&&B = false -> not equal.
        let lhs = small(1, 1);
        let rhs = Fraction::nil();
        assert_ne!(lhs, rhs, "non-nil and nil must not be equal");
    }

    #[test]
    fn aq_ver_001_a_row3_neither_nil_guard_skipped_compares_repr() {
        // (A=F, B=F): guard skipped, falls through to repr comparison.
        let lhs = small(2, 4); // reduces to 1/2
        let rhs = small(1, 2);
        assert_eq!(lhs, rhs, "1/2 and 2/4 must compare equal after reduction");

        let unequal = small(1, 3);
        assert_ne!(lhs, unequal);
    }

    #[test]
    fn aq_ver_001_a_row4_both_nil_returns_true() {
        // (A=T, B=T): inner A&&B = true -> nil equals nil.
        let lhs = Fraction::nil();
        let rhs = Fraction::nil();
        assert_eq!(lhs, rhs, "nil must equal nil");
    }

    // Rows (T,F) and (F,T) coincide with rows 1 and 2 above for the inner
    // A&&B decision: in both cases the inner expression yields false, which
    // is the outcome being verified. No additional cases required.
}

// AQ-VER-001-B
// DUT: rust/src/types/fraction.rs:369-376 in `impl Ord for Fraction::cmp`
//
//     if let (Some((a, b)), Some((c, d))) = (self.extract_i64_pair(),
//                                            other.extract_i64_pair()) {
//         if b == d { return a.cmp(&c); }
//         ...
//     }
//
// Conditions for the same-denominator branch:
//   A = self.extract_i64_pair().is_some()
//   B = other.extract_i64_pair().is_some()
//   C = b == d
//
// We test the three boundary combinations that exercise the if-let pattern
// (small/small, small/big, big/big) and, within the small/small arm, both
// values of C.
mod cmp_small_fast_path {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn aq_ver_001_b_small_small_same_denominator_compares_numerators() {
        // A=T, B=T, C=T: enters fast path, compares a vs c directly.
        let a = small(3, 7);
        let b = small(5, 7);
        assert_eq!(a.cmp(&b), Ordering::Less);
        assert_eq!(b.cmp(&a), Ordering::Greater);
        assert_eq!(a.cmp(&a.clone()), Ordering::Equal);
    }

    #[test]
    fn aq_ver_001_b_small_small_different_denominator_cross_multiplies() {
        // A=T, B=T, C=F: skips a.cmp(&c), takes the i128 cross-multiply path.
        // 1/3 vs 1/4 -> 4 vs 3 -> Greater.
        let a = small(1, 3);
        let b = small(1, 4);
        assert_eq!(a.cmp(&b), Ordering::Greater);
    }

    #[test]
    fn aq_ver_001_b_big_path_when_extraction_fails() {
        // A=F or B=F: at least one side is BigInt, falls through to BigInt
        // arithmetic. The same-denominator BigInt branch must also work.
        let a = big_int(0); // 2*i64::MAX, denominator 1
        let b = big_int(1); // 2*i64::MAX + 1, denominator 1
        assert_eq!(a.cmp(&b), Ordering::Less);
        assert_eq!(b.cmp(&a), Ordering::Greater);

        // Different-denominator BigInt path.
        let c = Fraction::new(BigInt::from(1), BigInt::from(i64::MAX) * BigInt::from(2));
        let d = Fraction::new(BigInt::from(1), BigInt::from(i64::MAX) * BigInt::from(3));
        assert_eq!(c.cmp(&d), Ordering::Greater);
    }
}

// AQ-VER-001-C
// DUT: rust/src/types/fraction.rs:232 in `Fraction::as_usize` (Small arm)
//
//     if *d == 1 && *n >= 0 { Some(*n as usize) } else { None }
//
// Conditions:
//   A = (d == 1)
//   B = (n >= 0)
//
// MC/DC table:
//   row 1: (T, T) -> Some
//   row 2: (T, F) -> None  (proves B flips outcome with A held T)
//   row 3: (F, T) -> None  (proves A flips outcome with B held T)
//   row 4: (F, F) -> None  (boundary; not required for MC/DC but documented)
//
// Note on reachability: a normalized Small fraction with d != 1 always has
// gcd(n, d) = 1, so non-integer values (rows 3, 4) are constructible via
// Fraction::new and remain in Small form when both numerator and denominator
// fit in i64.
mod as_usize_small {
    use super::*;

    #[test]
    fn aq_ver_001_c_row1_integer_nonneg_returns_some() {
        let f = small(42, 1);
        assert_eq!(f.as_usize(), Some(42));
    }

    #[test]
    fn aq_ver_001_c_row2_integer_negative_returns_none() {
        let f = small(-1, 1);
        assert_eq!(
            f.as_usize(),
            None,
            "negative integer must not coerce to usize"
        );
    }

    #[test]
    fn aq_ver_001_c_row3_nonintegral_positive_returns_none() {
        let f = small(3, 4);
        assert_eq!(f.as_usize(), None, "non-integer fraction must not coerce");
    }

    #[test]
    fn aq_ver_001_c_row4_nonintegral_negative_returns_none() {
        let f = small(-3, 4);
        assert_eq!(f.as_usize(), None);
    }
}

// AQ-VER-001-D
// DUT: rust/src/types/fraction-arithmetic.rs:54-58 in `Fraction::add`
//
//     if b == 1 && d == 1 {
//         return Self::create_from_i128((a as i128) + (c as i128), 1);
//     }
//     if b == d {
//         return Self::create_from_i128((a as i128) + (c as i128), b as i128);
//     }
//
// Decision 1 conditions (integer fast path):
//   A = (b == 1)
//   B = (d == 1)
//
// MC/DC table for A&&B:
//   row 1: (T, T) -> integer fast path
//   row 2: (T, F) -> falls through (B flips outcome with A held T)
//   row 3: (F, T) -> falls through (A flips outcome with B held T)
//
// Decision 2 conditions (same-denominator fast path):
//   C = (b == d)  reached when not (A && B)
//   row 4: C = T  -> common-denominator fast path
//   row 5: C = F  -> generic cross-multiply path
mod add_small_fast_paths {
    use super::*;

    #[test]
    fn aq_ver_001_d_decision1_row1_both_integer() {
        // (A=T, B=T): integer + integer fast path.
        let a = small(7, 1);
        let b = small(11, 1);
        let sum = a.add(&b);
        assert_eq!(sum, small(18, 1));
    }

    #[test]
    fn aq_ver_001_d_decision1_row2_self_integer_other_fraction() {
        // (A=T, B=F): self denominator 1, other not -> falls through to
        // Decision 2; b=1, d=3 -> b != d -> generic path. 7 + 1/3 = 22/3.
        let a = small(7, 1);
        let b = small(1, 3);
        let sum = a.add(&b);
        assert_eq!(sum, small(22, 3));
    }

    #[test]
    fn aq_ver_001_d_decision1_row3_self_fraction_other_integer() {
        // (A=F, B=T): symmetric to row 2. 1/3 + 7 = 22/3.
        let a = small(1, 3);
        let b = small(7, 1);
        let sum = a.add(&b);
        assert_eq!(sum, small(22, 3));
    }

    #[test]
    fn aq_ver_001_d_decision2_row4_same_denominator_nonunit() {
        // (A=F, B=F, C=T): both have denominator 5 -> common-den fast path.
        let a = small(2, 5);
        let b = small(1, 5);
        let sum = a.add(&b);
        assert_eq!(sum, small(3, 5));
    }

    #[test]
    fn aq_ver_001_d_decision2_row5_different_denominator() {
        // (A=F, B=F, C=F): generic cross-multiply path.
        // 1/3 + 1/4 = 7/12.
        let a = small(1, 3);
        let b = small(1, 4);
        let sum = a.add(&b);
        assert_eq!(sum, small(7, 12));
    }

    #[test]
    fn aq_ver_001_d_nil_short_circuit_takes_precedence() {
        // Documented invariant: nil propagates regardless of which side.
        // Outside the decisions above but covers the entry guard.
        let nil = Fraction::nil();
        let one = small(1, 1);
        assert!(nil.add(&one).is_nil());
        assert!(one.add(&nil).is_nil());
    }
}

// AQ-VER-001-E
// DUT: rust/src/types/fraction-arithmetic.rs:268 in `Fraction::floor` (Small)
//
//     let floored = if *n < 0 && r != 0 { q - 1 } else { q };
//
// Conditions:
//   A = (n < 0)
//   B = (r != 0)
//
// Reachability note: this code runs only after `is_integer()` returns false,
// so when `repr` is `Small` we have d > 1. Because `Fraction::new` reduces by
// gcd, any Small with d > 1 satisfies gcd(n, d) = 1, hence n % d != 0. So in
// normal use B = T always, and rows (T,F)/(F,F) are unreachable. We still
// exercise both A values to demonstrate independent effect of A, and we
// exercise the early-return path for integers as a separate row.
mod floor_negative_remainder {
    use super::*;

    #[test]
    fn aq_ver_001_e_row1_negative_with_remainder_rounds_toward_neg_inf() {
        // (A=T, B=T): -7/3 -> q=-2, r=-1, floored = -3.
        let f = small(-7, 3);
        assert_eq!(f.floor(), small(-3, 1));
    }

    #[test]
    fn aq_ver_001_e_row2_positive_with_remainder_truncates() {
        // (A=F, B=T): 7/3 -> q=2, r=1, floored = 2 (else branch).
        // Pair (row1, row2) holds B=T and flips A, demonstrating A's
        // independent effect on the outcome.
        let f = small(7, 3);
        assert_eq!(f.floor(), small(2, 1));
    }

    #[test]
    fn aq_ver_001_e_integer_short_circuits_before_decision() {
        // is_integer() short-circuit returns self before the decision is
        // evaluated. Documents the only realistic way to reach B = F.
        let f = small(-6, 1);
        assert_eq!(f.floor(), small(-6, 1));
    }

    #[test]
    fn aq_ver_001_e_big_path_negative_with_remainder() {
        // BigInt twin of row 1 to cover the parallel decision in the Big arm.
        // -18446744073709551616 (= -(2*i64::MAX + 2)) does not fit i64 so the
        // value stays in the Big representation. Divided by 3 it has trunc
        // quotient -6148914691236517205 with remainder -1, so floor = q - 1.
        let big_neg = BigInt::from_str("-18446744073709551616").unwrap();
        let f = Fraction::new(big_neg, BigInt::from(3));
        let expected = Fraction::new(
            BigInt::from_str("-6148914691236517206").unwrap(),
            BigInt::from(1),
        );
        assert_eq!(f.floor(), expected);
    }
}

// AQ-VER-001-F
// DUT: rust/src/types/fraction-arithmetic.rs:293 in `Fraction::ceil` (Small)
//
//     let ceiled = if *n > 0 && r != 0 { q + 1 } else { q };
//
// Conditions:
//   A = (n > 0)
//   B = (r != 0)
//
// Same reachability caveat as AQ-VER-001-E.
mod ceil_positive_remainder {
    use super::*;

    #[test]
    fn aq_ver_001_f_row1_positive_with_remainder_rounds_toward_pos_inf() {
        // (A=T, B=T): 7/3 -> q=2, r=1, ceiled = 3.
        let f = small(7, 3);
        assert_eq!(f.ceil(), small(3, 1));
    }

    #[test]
    fn aq_ver_001_f_row2_negative_with_remainder_truncates() {
        // (A=F, B=T): -7/3 -> q=-2, r=-1, ceiled = -2 (else branch).
        // Pair (row1, row2) flips A with B held T -> independent effect of A.
        let f = small(-7, 3);
        assert_eq!(f.ceil(), small(-2, 1));
    }

    #[test]
    fn aq_ver_001_f_zero_short_circuits_via_is_integer() {
        // Zero is is_integer() == true (d == 1 after reduction), short-circuits.
        let f = small(0, 5);
        assert_eq!(f.ceil(), small(0, 1));
    }
}

// ---------------------------------------------------------------------------
// AQ-VER-001-G
// DUT: rust/src/types/fraction.rs:266-269 in `Fraction::create_from_i128`
//
//     if n >= i64::MIN as i128 && n <= i64::MAX as i128
//         && d >= 0 && d <= i64::MAX as i128
//     {
//         return Fraction { repr: FractionRepr::Small(n as i64, d as i64) };
//     }
//
// This 4-condition AND decides whether the i128 (numerator, denominator) pair
// fits the Small representation. Conditions:
//   A = n >= i64::MIN as i128
//   B = n <= i64::MAX as i128
//   C = d >= 0
//   D = d <= i64::MAX as i128
//
// Reachability:
//   A, B, D each gate a distinct overflow direction (n underflow, n overflow,
//   d overflow). All three are reachable through arithmetic that produces
//   results outside i64 range (e.g., adding two near-i64::MAX values).
//
//   C is structurally always T at this site: the immediately preceding block
//   at fraction.rs:261-264 normalizes d to be non-negative
//   (`if d < 0 { n = -n; d = -d; }`), so by the time line 267 evaluates
//   `d >= 0`, this condition is invariant. Treated as defensive code; the
//   row C=F is unreachable without bypassing the normalizer.
//
// MC/DC over A && B && D (with C held T):
//   row 1: (A=T, B=T, D=T) -> Small  (n in i64 range, d in i64 range)
//   row 2: (A=F, B=T, D=T) -> Big    (n < i64::MIN as i128)
//   row 3: (A=T, B=F, D=T) -> Big    (n > i64::MAX as i128)
//   row 4: (A=T, B=T, D=F) -> Big    (d > i64::MAX as i128)
//
// Independent effect:
//   Pair (1, 2) with B,D held T: A flips T->F -> outcome flips Small->Big.
//   Pair (1, 3) with A,D held T: B flips T->F -> outcome flips Small->Big.
//   Pair (1, 4) with A,B held T: D flips T->F -> outcome flips Small->Big.
// ---------------------------------------------------------------------------
mod create_from_i128_small_big_boundary {
    use super::*;

    #[test]
    fn aq_ver_001_g_row1_in_range_returns_small() {
        // (A=T, B=T, D=T): 5/3, both fit i64.
        let f = Fraction::create_from_i128(5, 3);
        assert!(f.is_small(), "in-range pair must produce Small");
        assert_eq!(f, small(5, 3));
    }

    #[test]
    fn aq_ver_001_g_row2_numerator_underflow_returns_big() {
        // (A=F, B=T, D=T): n = i64::MIN - 1 as i128, which is below i64 range.
        // Pair (row1, row2) with B,D held T proves A's independent effect.
        let n: i128 = (i64::MIN as i128) - 1;
        let f = Fraction::create_from_i128(n, 1);
        assert!(!f.is_small(), "n below i64::MIN must promote to Big");
        // Confirm magnitude survives the round-trip through BigInt.
        assert_eq!(f, Fraction::new(BigInt::from(n), BigInt::from(1)));
    }

    #[test]
    fn aq_ver_001_g_row3_numerator_overflow_returns_big() {
        // (A=T, B=F, D=T): n = i64::MAX + 1 as i128, which is above i64 range.
        // Pair (row1, row3) with A,D held T proves B's independent effect.
        let n: i128 = (i64::MAX as i128) + 1;
        let f = Fraction::create_from_i128(n, 1);
        assert!(!f.is_small(), "n above i64::MAX must promote to Big");
        assert_eq!(f, Fraction::new(BigInt::from(n), BigInt::from(1)));
    }

    #[test]
    fn aq_ver_001_g_row4_denominator_overflow_returns_big() {
        // (A=T, B=T, D=F): d > i64::MAX as i128. Use n = 1 (positive, in range)
        // and d = (i64::MAX as i128) + 2 (gcd-coprime with 1, so no reduction
        // shrinks d back into range).
        // Pair (row1, row4) with A,B held T proves D's independent effect.
        let d: i128 = (i64::MAX as i128) + 2;
        let f = Fraction::create_from_i128(1, d);
        assert!(!f.is_small(), "d above i64::MAX must promote to Big");
        assert_eq!(f, Fraction::new(BigInt::from(1), BigInt::from(d)));
    }

    #[test]
    fn aq_ver_001_g_normalizes_negative_denominator_before_check() {
        // C=T invariant check: a negative d input is normalized to positive
        // before line 267 evaluates `d >= 0`. The result still depends on
        // A,B,D. Here d = -3 is normalized to d = +3 with sign flipped onto n.
        let f = Fraction::create_from_i128(5, -3);
        assert!(
            f.is_small(),
            "after normalization both n,d fit i64 -> Small"
        );
        assert_eq!(f, small(-5, 3));
    }
}

// ---------------------------------------------------------------------------
// AQ-VER-001-H
// DUT: rust/src/types/fraction-arithmetic.rs:53 in `Fraction::add`
//
//     if let (Some((a, b)), Some((c, d))) =
//         (self.extract_i64_pair(), other.extract_i64_pair()) { /* fast path */ }
//
// Tuple-destructuring guard at the entry of the i64 fast path. Conditions:
//   A = self.extract_i64_pair().is_some()    (self fits i64 pair)
//   B = other.extract_i64_pair().is_some()   (other fits i64 pair)
//
// extract_i64_pair returns Some for any Small fraction unconditionally, and
// for Big fractions only when both numerator and denominator individually
// fit i64 (rust/src/types/fraction.rs:204-213). A genuine Big fraction whose
// numerator overflows i64 returns None.
//
// MC/DC over A && B:
//   row 1: (A=T, B=T) -> fast path entered; result computed in i128
//   row 2: (A=F, B=T) -> fast path skipped; falls through to BigInt arm
//   row 3: (A=T, B=F) -> fast path skipped; falls through to BigInt arm
//
// Independent effect:
//   Pair (1, 2) with B held T: A flips T->F -> path flips fast->big.
//   Pair (1, 3) with A held T: B flips T->F -> path flips fast->big.
//
// We observe path selection indirectly: for row 1 we verify the result is
// Small (no boundary crossing); for rows 2 and 3 we verify the BigInt arm
// preserves correctness when one operand exceeds i64.
// ---------------------------------------------------------------------------
mod add_small_fast_path_entry_guard {
    use super::*;

    #[test]
    fn aq_ver_001_h_row1_both_small_uses_fast_path() {
        // (A=T, B=T): both Small, result fits i64 -> Small returned.
        let lhs = small(2, 3);
        let rhs = small(1, 6);
        let result = lhs.add(&rhs);
        assert!(result.is_small(), "two Small operands with i64-fitting sum");
        assert_eq!(result, small(5, 6));
    }

    #[test]
    fn aq_ver_001_h_row2_self_big_skips_fast_path() {
        // (A=F, B=T): self is Big (numerator > i64::MAX) -> falls into BigInt arm.
        // Pair (row1, row2) flips A with B held T.
        let big = big_int(0); // 2*i64::MAX, exceeds i64
        let small_one = small(1, 1);
        let result = big.add(&small_one);
        // Expected: 2*i64::MAX + 1
        let expected_num = BigInt::from(i64::MAX) * BigInt::from(2i64) + BigInt::from(1i64);
        assert_eq!(result, Fraction::new(expected_num, BigInt::from(1)));
        assert!(
            !result.is_small(),
            "Big + Small with overflow must stay Big"
        );
    }

    #[test]
    fn aq_ver_001_h_row3_other_big_skips_fast_path() {
        // (A=T, B=F): other is Big -> falls into BigInt arm.
        // Pair (row1, row3) flips B with A held T.
        let small_one = small(1, 1);
        let big = big_int(0);
        let result = small_one.add(&big);
        let expected_num = BigInt::from(i64::MAX) * BigInt::from(2i64) + BigInt::from(1i64);
        assert_eq!(result, Fraction::new(expected_num, BigInt::from(1)));
        assert!(
            !result.is_small(),
            "Small + Big with overflow must stay Big"
        );
    }
}

// ---------------------------------------------------------------------------
// AQ-VER-001-I
// DUT: rust/src/types/fraction-arithmetic.rs:60-64 in `Fraction::add`
//
//     if let Some(num) = (a as i128).checked_mul(d as i128)        // X
//         .and_then(|ad| (c as i128).checked_mul(b as i128)        // Y
//             .and_then(|cb| ad.checked_add(cb)))                  // Z
//     { return Self::create_from_i128(num, (b as i128) * (d as i128)); }
//
// Three checked operations chained with and_then. Atomic conditions:
//   X = (a as i128).checked_mul(d as i128).is_some()
//   Y = (c as i128).checked_mul(b as i128).is_some()
//   Z = ad.checked_add(cb).is_some()
//
// Reachability proof for the None arm (i.e., the fall-through to the BigInt
// arm at lines 68+):
//   The site is guarded by extract_i64_pair returning Some for both operands,
//   so a, c are i64 (range [-2^63, 2^63 - 1]) and b, d are i64 denominators
//   normalized non-negative (range [1, 2^63 - 1]).
//
//   |a as i128| <= 2^63;  |d as i128| <= 2^63 - 1
//   |a*d| <= 2^63 * (2^63 - 1) = 2^126 - 2^63 < 2^127 = i128::MAX + 1
//   So X = T for all valid inputs. Symmetric argument: Y = T for all valid
//   inputs.
//
//   ad and cb each lie in [-(2^126 - 2^63), 2^126 - 2^63].
//   |ad + cb| <= 2 * (2^126 - 2^63) = 2^127 - 2^64 < 2^127.
//   So Z = T for all valid inputs.
//
//   Therefore X && Y && Z = T whenever the fast path is entered. The None
//   arm is structurally unreachable from i64 operands; it is defensive code
//   guarding against a future regression where the upstream contracts (e.g.,
//   non-negative denominator) are weakened.
//
// MC/DC table:
//   row 1: (X=T, Y=T, Z=T)         -> Some(num); REACHABLE (asserted below)
//   row 2: (X=F, Y=*, Z=*)         -> None;      UNREACHABLE (proof above)
//   row 3: (X=T, Y=F, Z=*)         -> None;      UNREACHABLE (proof above)
//   row 4: (X=T, Y=T, Z=F)         -> None;      UNREACHABLE (proof above)
//
// Because rows 2-4 cannot be constructed without violating the i64 range
// invariant, classic MC/DC pair construction does not apply; the test below
// instead exercises row 1 at the operand boundary closest to the i128 limit
// to demonstrate the proof's tightness empirically.
// ---------------------------------------------------------------------------
mod add_checked_chain_defensive {
    use super::*;

    #[test]
    fn aq_ver_001_i_row1_extreme_i64_inputs_succeed_in_i128() {
        // Operands chosen at the i64 boundary so that |a*d| + |c*b| approaches
        // (but does not exceed) i128::MAX.
        //   a = i64::MAX, d = i64::MAX  -> ad = (2^63 - 1)^2 = 2^126 - 2^64 + 1
        //   c = i64::MAX, b = i64::MAX  -> cb = same
        //   sum = 2 * (2^126 - 2^64 + 1) = 2^127 - 2^65 + 2 < i128::MAX
        // Both fractions are i64::MAX/i64::MAX = 1, so the sum is 2.
        // Although the result is small, the intermediate i128 arithmetic
        // exercises the X, Y, Z chain at the proof's worst case.
        let lhs = small(i64::MAX, i64::MAX);
        let rhs = small(i64::MAX, i64::MAX);
        let result = lhs.add(&rhs);
        assert_eq!(
            result,
            small(2, 1),
            "i64::MAX/i64::MAX + i64::MAX/i64::MAX = 2"
        );
    }

    #[test]
    fn aq_ver_001_i_row1_negative_extreme_i64_inputs_succeed_in_i128() {
        // Negative-side worst case (avoiding the literal i64::MIN, which would
        // panic in `compute_gcd_i64::abs()` during the Fraction::new normalizer
        // at fraction.rs:8 before reaching the checked-chain DUT):
        //   a = -i64::MAX, d = i64::MAX -> ad = -(2^63 - 1)^2
        //   c = -i64::MAX, b = i64::MAX -> cb = -(2^63 - 1)^2
        //   |ad + cb| = 2 * (2^63 - 1)^2 < 2^127 = i128::MAX + 1.
        // Both fractions are -i64::MAX/i64::MAX = -1, sum = -2.
        let lhs = small(-i64::MAX, i64::MAX);
        let rhs = small(-i64::MAX, i64::MAX);
        let result = lhs.add(&rhs);
        assert_eq!(result, small(-2, 1), "-i64::MAX/i64::MAX + same = -2");
    }
}

// ---------------------------------------------------------------------------
// AQ-VER-001-J
// DUT: rust/src/types/fraction-arithmetic.rs:354-358 in `Fraction::modulo`
// (Small fast path, b == 1 && d == 1)
//
//     let result = if rem < 0 {
//         if c > 0 { rem + c } else { rem - c }
//     } else {
//         rem
//     };
//
// Sign-normalizing branch over the integer remainder. Conditions:
//   A = (rem < 0)
//   B = (c > 0)
//
// Three reachable branches:
//   row 1: (A=F, B=any) -> rem        (no sign correction)
//   row 2: (A=T, B=T)   -> rem + c    (positive divisor, normalize to [0, c))
//   row 3: (A=T, B=F)   -> rem - c    (negative divisor, normalize to (c, 0])
//
// MC/DC pairs:
//   Pair (row 1, row 2) with B held T (positive c, e.g., c=3):
//     A flips F->T -> branch flips from `rem` to `rem + c`. A independent.
//   Pair (row 2, row 3) with A held T (negative rem, e.g., a=-7):
//     B flips T->F -> branch flips from `rem + c` to `rem - c`. B independent.
//
// Modulo by zero is rejected at line 348 (panics) before reaching this
// branch, so c == 0 is not part of the reachable input space.
//
// Expected values were verified by an offline probe (2026-04-24):
//   a= 7, c= 3, rem= 1, result=1   (row 1, A=F, B=T)
//   a=-7, c= 3, rem=-1, result=2   (row 2, A=T, B=T)
//   a=-7, c=-3, rem=-1, result=2   (row 3, A=T, B=F)
//   a= 7, c=-3, rem= 1, result=1   (row 1', A=F, B=F)
// ---------------------------------------------------------------------------
mod modulo_remainder_sign_normalization {
    use super::*;

    #[test]
    fn aq_ver_001_j_row1_nonneg_remainder_returns_remainder_unchanged() {
        // (A=F, B=T): rem = 7 % 3 = 1 >= 0, no sign correction.
        let result = small(7, 1).modulo(&small(3, 1));
        assert_eq!(result, small(1, 1));
    }

    #[test]
    fn aq_ver_001_j_row2_neg_remainder_pos_divisor_adds_divisor() {
        // (A=T, B=T): rem = -7 % 3 = -1 < 0 and c = 3 > 0, result = -1 + 3 = 2.
        // Pair (row1, row2) with B held T proves A's independent effect.
        let result = small(-7, 1).modulo(&small(3, 1));
        assert_eq!(result, small(2, 1));
    }

    #[test]
    fn aq_ver_001_j_row3_neg_remainder_neg_divisor_subtracts_divisor() {
        // (A=T, B=F): rem = -7 % -3 = -1 < 0 and c = -3 not > 0, result = -1 - (-3) = 2.
        // Pair (row2, row3) with A held T proves B's independent effect.
        let result = small(-7, 1).modulo(&small(-3, 1));
        assert_eq!(result, small(2, 1));
    }

    #[test]
    fn aq_ver_001_j_row1_alt_pos_remainder_neg_divisor_returns_remainder() {
        // (A=F, B=F): rem = 7 % -3 = 1 >= 0, no sign correction (returns rem).
        // Documents the (A=F, B=F) cell of the truth table; not used in MC/DC
        // pairs but covers the entire reachable surface of the inner branch.
        let result = small(7, 1).modulo(&small(-3, 1));
        assert_eq!(result, small(1, 1));
    }
}

// ---------------------------------------------------------------------------
// i64::MIN normalization (regression)
// DUT: rust/src/types/fraction.rs `compute_gcd_i64` and `Fraction::new`
//
// `i64::MIN` has no positive i64 counterpart, so `i64::MIN.abs()` and
// `-i64::MIN` both overflow and panic. The old gcd reduced operands with
// signed `abs()`, and `Fraction::new` sign-normalized the Small path with
// `num = -num`; either crashed the interpreter as soon as a
// `-9223372036854775808` literal entered the fraction normalizer (most
// visibly when stored inside a vector/tensor). These tests pin the totalized
// behavior: every i64::MIN form must reduce to an exact value rather than
// panic.
// ---------------------------------------------------------------------------
mod i64_min_normalization {
    use super::*;

    #[test]
    fn new_accepts_i64_min_numerator() {
        // Previously panicked in compute_gcd_i64's signed abs().
        let f = Fraction::new(BigInt::from(i64::MIN), BigInt::from(1));
        assert_eq!(f, small(i64::MIN, 1));
    }

    #[test]
    fn new_accepts_i64_min_over_negative_one() {
        // Sign normalization (`num = -num`) used to overflow on i64::MIN; the
        // exact value 2^63 no longer fits in i64 and must widen to Big.
        let f = Fraction::new(BigInt::from(i64::MIN), BigInt::from(-1));
        let expected = Fraction::new(-BigInt::from(i64::MIN), BigInt::from(1));
        assert_eq!(f, expected);
    }

    #[test]
    fn new_reduces_i64_min_over_i64_min_to_one() {
        let f = Fraction::new(BigInt::from(i64::MIN), BigInt::from(i64::MIN));
        assert_eq!(f, small(1, 1));
    }

    #[test]
    fn multiply_i64_min_operands_widens_to_big() {
        // i64::MIN * i64::MIN == 2^126, well outside i64; must not panic.
        let product = small(i64::MIN, 1).mul(&small(i64::MIN, 1));
        let expected = Fraction::new(
            BigInt::from(i64::MIN) * BigInt::from(i64::MIN),
            BigInt::from(1),
        );
        assert_eq!(product, expected);
    }
}

// ---------------------------------------------------------------------------
// Scientific-notation exponent overflow (regression)
// DUT: rust/src/types/fraction.rs `Fraction::from_str` exponent branch
//
// The negative-exponent branch computed `(-exponent) as u32`. For the literal
// `1e-2147483648` the exponent parses to i32::MIN, whose negation overflows i32
// and panicked the interpreter (reachable from a source literal and from `NUM`
// on a string). `unsigned_abs` takes the magnitude without overflow.
// ---------------------------------------------------------------------------
mod scientific_exponent_overflow {
    use super::*;

    #[test]
    fn from_str_handles_i32_min_negative_exponent_small() {
        // 1e-1 still parses fine through the same magnitude path.
        let f = Fraction::from_str("1e-1").unwrap();
        assert_eq!(f, small(1, 10));
    }

    #[test]
    fn from_str_does_not_panic_on_i32_min_exponent_magnitude() {
        // We only assert it returns an Ok value rather than panicking; the
        // resulting denominator is astronomically large but well-formed. Use a
        // mantissa of 0 so the heavy power is multiplied away and the test stays
        // fast while still exercising the magnitude computation.
        let f = Fraction::from_str("0e-2147483648");
        assert!(f.is_ok(), "i32::MIN exponent must not panic");
        assert_eq!(f.unwrap(), small(0, 1));
    }
}
