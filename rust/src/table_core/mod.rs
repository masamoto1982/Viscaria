//! Table-oriented core (`SPECIFICATION.html`).
//!
//! This module tree is the Phase 1 foundation of Viscaria's table-oriented
//! language core (`docs/dev/ajisai-table-oriented-language-plan.md`). It is not
//! wired into the WASM boundary or playground yet; those layers will consume
//! the stable identities, values, and reference bindings defined here.
//!
//! The core reuses the exact-real continued-fraction kernel unchanged
//! (`crate::types::continued_fraction`, `crate::types::fraction`) while adding
//! the atomic cell model and document-owned table storage required by the
//! canonical specification.

pub mod cell_value;
pub mod table_store;
