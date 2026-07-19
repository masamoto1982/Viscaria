# Numbers-first product priorities

Status: active product direction (2026-07-19)

Viscaria prioritizes the document and interaction qualities of Apple Numbers over any particular numeric representation.

## Product principle

The user-visible document model is the product. Numeric representation, including continued fractions and exact-real machinery, is an interchangeable implementation detail and must not delay the spreadsheet experience.

The project should first become a useful finite-canvas spreadsheet and drawing document:

- a document contains ordered sheets;
- each sheet is a finite page/canvas;
- tables and other objects can be placed freely on that canvas;
- tables have stable identities, finite row/column extents, headers, names, formulas, and formatting;
- selection, editing, resizing, moving, copying, undo/redo, and keyboard navigation feel immediate;
- formulas and references survive layout and naming changes;
- documents save and restore reliably;
- print/export reflects the visible layout.

## Priority order

1. **Document persistence** — serialize and restore sheets, tables, cells, identities, formulas, layout, and formatting.
2. **Sheet and object model** — multiple sheets, finite paper/canvas, freely positioned and resized tables.
3. **Table editing** — add/remove rows and columns, headers, selection ranges, copy/paste, fill, keyboard navigation, undo/redo.
4. **Formula experience** — formula bar, references, dependency tracking, recalculation, and visible diagnostics.
5. **Presentation** — cell formats, borders, alignment, merged presentation spans, print/export.
6. **Mobile interaction** — touch selection, explicit edit mode, pinch/scroll, compact controls.
7. **Numeric sophistication** — exact rationals/reals, continued fractions, advanced diagnostics, and performance specialization only where they improve the product without blocking the items above.

## Architectural rule

Core APIs must not expose or require a particular scalar representation. A scalar backend may begin with ordinary integers/decimals or reduced rationals and be replaced later. Stable document, table, cell, and formula identities are more important than the scalar encoding.

## Immediate next slice

Build a persistent document model that connects the existing playground sheets and positioned cells/tables to stable Rust identities. The first end-to-end milestone is:

1. create a document with multiple sheets;
2. place and resize a finite table on a sheet;
3. edit literal values and names;
4. save, reload, and preserve identity, layout, and references;
5. undo and redo the edits.

Formula evaluation beyond simple references should follow after this vertical slice works reliably.
