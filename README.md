# Viscaria

**Viscaria** is an AI-first, table-oriented, exact-real **spreadsheet language** —
the table-oriented redesign of [Ajisai](https://github.com/masamoto1982/Ajisai).

The name is a nod to **VisiCalc**, the first spreadsheet; *Viscaria* is also a flowering
plant, continuing Ajisai's (hydrangea) botanical lineage.

## Playground

A live playground is published to GitHub Pages from `web/` (a build-free static site).
The shell is a **five-level nested-cell** board: a parent cell (親, level 1) holds child
cells (子), which hold grandchildren (孫), then great-grandchildren (ひ孫), then
great-great-grandchildren (玄孫) — five levels total. Every cell is a **two-faced card**:
the front of a leaf cell is its value (double-click to edit), while a cell with children
shows the children themselves, filling the card; right-click a selected cell to flip it
over to the back, where its **name** lives (double-click to rename) along with the
add-child/delete controls. Every cell but a parent moves by drag & drop with grid snap
(drop onto a cell to nest it there, respecting the five-level cap; drop onto the empty
board to promote it to a parent), and every cell resizes by its corner handle.
Exact-arithmetic evaluation is wired next, through the Rust core compiled to WASM — the
cell's raw text is the human-facing surface, kept separate from the internal exact-real
representation, and deliberately not faked in JS floats, because exactness is the point.

## What it is

A program is a **document**: named tables laid out on sheets, plus a word dictionary.
Evaluation is **recalculation** — cells hold formulas, and a change propagates through the
dependency graph deterministically.

Design pillars (see [`SPECIFICATION.html`](SPECIFICATION.html), the canonical authority):

- **Pure functional by axiom.** Cell evaluation is effect-free and deterministic;
  recalculation is order- and parallelism-independent (confluence). Not a spreadsheet that
  *became* functional by accretion — one designed that way from the start.
- **Flat Cell principle.** Structure lives in the grid; a cell holds exactly one *atomic*
  value (a vessel holds one water). No nested values.
- **Exact reals.** Every number is an exact real represented as a (possibly lazy)
  continued fraction, carried over unchanged from Ajisai — so `0.1 + 0.2` is exact and
  `√2 = √2` decides. No floating point anywhere.
- **Reason-carrying failure.** Errors are not opaque constants: a well-formed operation
  that misses its domain yields a `NIL` bubble with a machine-readable reason; an
  undecidable comparison yields the logical `Unknown`.
- **Function tables, not LAMBDA.** An n-ary function is a table with parameter columns and
  an output column; example rows are its live definition, its unit tests, and a memo table
  at once.
- **Value integrity.** A numeric format *is* `QUANTIZE` (display rounding preserves the
  exact value and records the residual); `CONSERVE` and `EXPECT` are fail-loud table
  invariants.

## Layout

```
SPECIFICATION.html          canonical language specification
docs/dev/                   design record (plan, functional foundations, cell addressing)
rust/                       the core (viscaria-core)
  src/types/                exact-real continued-fraction kernel (SPEC §4.2)
  src/table_core/           atomic cell value model (SPEC §4.1); more phases to come
```

## Build

```sh
cd rust
cargo test
```

The Rust toolchain is pinned in `rust/rust-toolchain.toml`.

## Status

Early. The value model (§4) exists; the table store, formula evaluator, recalculation
engine, WASM boundary, and GUI are the next phases
(`docs/dev/ajisai-table-oriented-language-plan.md`).

## Relationship to Ajisai

Viscaria is a breaking redesign, not a fork of Ajisai's runtime. It reuses Ajisai's
exact-real continued-fraction kernel and inherits its NIL/Unknown/QUANTIZE/CONSERVE
semantics; it drops vector orientation entirely. The language is still called *Ajisai* in
the specification; *Viscaria* names this project and its application.
