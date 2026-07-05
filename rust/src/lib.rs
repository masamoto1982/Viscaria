//! Viscaria — an AI-first, table-oriented, exact-real spreadsheet language.
//!
//! Viscaria is the table-oriented redesign of Ajisai: the spreadsheet is the
//! language, structure lives in the grid (the Flat Cell principle), and every
//! numeric value is an exact real represented as a continued fraction. The
//! canonical design authority is `SPECIFICATION.html`; the design record is in
//! `docs/dev/`.
//!
//! This crate is being built up in phases (see
//! `docs/dev/ajisai-table-oriented-language-plan.md`). Present modules:
//!
//! - [`types`] — the exact-real continued-fraction kernel (§4.2), carried over
//!   unchanged from the vector-oriented predecessor.
//! - [`table_core`] — the atomic cell value model (§4.1) and, in later phases,
//!   the table store, formula evaluator, and recalculation engine.

pub mod table_core;
pub mod types;
