//! Table-oriented core (`SPECIFICATION-NEXT.html`).
//!
//! This module tree is the Phase 1 foundation of the table-oriented redesign
//! (`docs/dev/ajisai-table-oriented-language-plan.md`). It is built in parallel
//! with the shipped vector-oriented interpreter, which remains the canonical
//! runtime until the swap described in `SPECIFICATION-NEXT.html` §15.3. Nothing
//! here is wired into the shipped runtime, the WASM bindings, or the CLI yet;
//! the shipped interpreter continues to serve as this core's acceptance
//! baseline for the atomic-value vocabulary it inherits.
//!
//! What it reuses unchanged from the current implementation: the exact-real
//! continued-fraction kernel (`crate::types::continued_fraction`,
//! `crate::types::fraction`) that `SPECIFICATION-NEXT.html` §4.2 carries over
//! verbatim.

pub mod cell_value;
