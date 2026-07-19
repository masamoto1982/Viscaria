# Table store foundation

Status: implemented foundation, non-canonical design record (2026-07-19)

## Purpose

`rust/src/table_core/table_store.rs` establishes the first document-owned table store for the Viscaria core. It implements the identity rule in `SPECIFICATION.html` §5.3: coordinates and names are presentation spellings, while formulas bind to stable table and cell identities.

## Included

- finite rectangular tables with non-zero dimensions;
- document-unique, case-insensitive table namespaces;
- stable `TableId` and `CellId` allocation;
- A1 parsing and rendering, including multi-letter columns;
- exact preservation of existing cell identities when a table grows;
- atomic `CellValue` storage and explicit clearing to `Empty`;
- case-insensitive landmark names within a table;
- local and table-qualified reference resolution;
- `BoundCellRef`, which stores identities rather than source text;
- rendering a bound reference through the table/cell's current preferred names;
- unit tests for addresses, identity stability, naming, growth, and reference binding.

## Deliberate boundaries

This slice does not parse formulas, build dependency edges, insert/delete rows or columns, or recalculate values. Those layers should consume `BoundCellRef` so structural changes cannot silently redirect an existing formula to a different cell.

Table shrinking is intentionally rejected for now. Deletion semantics require explicit tombstones and formula diagnostics; silently discarding identities would violate §5.3.

## Next slice

Add a formula/reference binding layer that converts parsed cell-reference tokens into `BoundCellRef`, followed by the forward/reverse dependency indexes required by §9.1.
