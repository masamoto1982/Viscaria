//! Exact-real numeric kernel.
//!
//! This is the continued-fraction kernel of `SPECIFICATION.html` §4.2, carried
//! over unchanged from the vector-oriented predecessor (the Ajisai repository)
//! per the redesign plan (`docs/dev/ajisai-table-oriented-language-plan.md`,
//! asset #1). It is self-contained: it depends only on the `num-*` crates and
//! the standard library, not on any grid, value-of-cell, or presentation code.
//!
//! - [`fraction::Fraction`] — an exact reduced rational (i64 fast path with a
//!   BigInt fallback).
//! - [`continued_fraction::ExactReal`] — an exact real represented as a
//!   (possibly lazy) continued fraction: `Rational`, `AlgebraicSqrt`, or an
//!   unevaluated `Gosper` bihomographic transform.

// The kernel files below are kept byte-identical to the predecessor's so the
// two projects can be diffed and, if desired, re-synced. A few of the kernel's
// `pub(crate)` helpers are not yet exercised by the table-oriented crate, and
// the code predates some newer clippy style lints. Scope those allowances to
// the kernel module only, so the actively-developed `table_core` keeps full
// linting.
#![allow(dead_code)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::should_implement_trait)]
#![allow(clippy::manual_is_multiple_of)]

pub mod continued_fraction;
pub mod fraction;
mod fraction_arithmetic;

#[cfg(test)]
mod fraction_mcdc_tests;
