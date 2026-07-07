# Viscaria

**Viscaria** is an AI-first, table-oriented, exact-real **spreadsheet language** —
the table-oriented redesign of [Ajisai](https://github.com/masamoto1982/Ajisai).

The name is a nod to **VisiCalc**, the first spreadsheet; *Viscaria* is also a flowering
plant, continuing Ajisai's (hydrangea) botanical lineage.

## Playground

A live playground is published to GitHub Pages from `web/` (a build-free static site).
Viscaria is heading toward a **WYSIWYG drawing program with formulas** in the Apple Numbers
sense. A document is a set of **sheets** (tabs at the bottom; a sheet's name is its
namespace), and each sheet is a **sheet of paper** of a standard office size — A3, B4, A4,
B5, or A5, portrait or landscape (chosen in the top bar). You place **cells** on the paper:
a top-level cell is a **parent** (親, level 1), holding children (子, level 2),
grandchildren (孫), great-grandchildren (ひ孫), and great-great-grandchildren (玄孫) — five
levels. Every card is **two-faced**: the front of a leaf cell is its value (double-click to
edit, centered by default), while a card with children shows the children themselves,
filling the card; right-click a selected card to flip it over to the back, where its
**name** lives (double-click to rename) along with the add-child/delete controls.
Right-click the bare paper to add a 親. Every card moves by drag & drop: positions snap to a
16px grid (invisible), and shoving a card **into** a sibling snaps their edges flush — cards
tile into tables — while merely coming near leaves the grid in charge. Drop onto a card's
interior to nest there, or onto the bare paper to make it a top-level 親 (five-level cap
enforced). Every card resizes by its corner handle. Cross-sheet value references
(`=SheetName!cellName`, Google Sheets style) are the next slice.

Numbers already follow Ajisai: a committed numeric value normalizes to the **canonical
reduced fraction** (`6/2` → `3/1`, `0.5` → `1/2`) with exact BigInt arithmetic — no
floats — and a **LaTeX toggle** (KaTeX, vendored like Ajisai's math view) renders those
fractions typeset. Exact-real *evaluation* is wired next, through the Rust core compiled
to WASM; the cell's visible text stays the human-facing surface, separate from the
internal representation.

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

Viscaria is now an **independent language**, named and specified as *Viscaria* in its own
right (see [`SPECIFICATION.html`](SPECIFICATION.html)) — no longer "the table-oriented
Ajisai". It descends from Ajisai as a breaking redesign, not a fork of its runtime, and it
**continues to reuse Ajisai's mechanisms**: the exact-real continued-fraction kernel, the
NIL/Unknown/QUANTIZE/CONSERVE semantics, and GUI approaches like the fraction/LaTeX math
view. It drops vector orientation entirely. Ajisai remains the acknowledged upstream we
borrow from; that reuse is expected to continue.
