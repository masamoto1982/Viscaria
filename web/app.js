// Viscaria playground — grid shell with multiple named tables per sheet.
//
// Scope of this slice: a Numbers/Sheets-style square-cell grid with selection,
// in-cell and formula-bar editing, keyboard navigation, and multiple sheets —
// where each sheet now holds *several* named tables rather than one grid. A
// table's name is its namespace (design note docs/dev/ajisai-cell-addressing.md
// §3, §7): tables are auto-named (`Table1`, `Table2`, …), document-unique, and
// renamable, and a cell is addressed `Table.A1`. The name box resolves that
// namespaced form to jump across tables (and sheets).
//
// Tables float freely on the sheet: right-click the sheet to open a menu that
// asks for the column and row counts and drops a new table where you clicked,
// and drag a table by its name header to reposition it anywhere. Cells hold
// literal values (numbers / text); numbers right-align. Formula evaluation
// (`=Table.A1+B1`) with EXACT continued-fraction arithmetic is the next slice,
// wired through the Rust core compiled to WASM — deliberately not faked in JS
// floats here, because exactness is the whole point.

const DEFAULT_COLS = 5;
const DEFAULT_ROWS = 8;
const MAX_COLS = 50;
const MAX_ROWS = 200;

/** Clamp a menu input to an integer in [lo, hi], falling back to `dflt`. */
function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

// ---- address helpers --------------------------------------------------------

/** 0-based column index → letters (0→A, 25→Z, 26→AA). */
function colLabel(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}
const addr = (c, r) => `${colLabel(c)}${r + 1}`;

/** "B3" → {c, r} (0-based) within a table's bounds, or null. */
function parseCellAddr(text, t) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(text.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = parseInt(m[2], 10) - 1;
  c -= 1;
  if (c < 0 || c >= t.cols || r < 0 || r >= t.rows) return null;
  return { c, r };
}

const numberRe = /^-?(\d+(\.\d+)?|\d+\/\d+)$/;
const kindOf = (raw) => (raw !== "" && numberRe.test(raw.trim()) ? "number" : "text");

// ---- model ------------------------------------------------------------------
//
// doc → sheets → tables → cells. A table owns its own grid dimensions, its
// free-floating position (x, y) on the sheet, a stacking order (z), a sparse
// map of address → raw text, and a list of merged regions. Table names are
// document-unique namespaces; `cellEls` is transient render state (rebuilt each
// render), not part of the document.
//
// A merged region `{ c, r, cw, rh }` is one cell (its anchor is the top-left
// (c, r)) occupying a cw×rh rectangle; the covered addresses have no identity of
// their own and resolve to the anchor (design note §3.3).

let idSeq = 0;
let zTop = 0; // most-recently-touched table floats above the rest
const makeTable = (name, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, x = 24, y = 24) => ({
  id: `t${++idSeq}`,
  name,
  cols,
  rows,
  x,
  y,
  z: ++zTop,
  cells: new Map(),
  merges: [],
  cellEls: new Map(),
});

// ---- merged regions ---------------------------------------------------------

/** The merge region covering cell (c, r), or null. */
function mergeAt(t, c, r) {
  for (const m of t.merges) {
    if (c >= m.c && c < m.c + m.cw && r >= m.r && r < m.r + m.rh) return m;
  }
  return null;
}

/** True if (c, r) is inside a merge but is not its anchor (i.e. hidden). */
function isCovered(t, c, r) {
  const m = mergeAt(t, c, r);
  return m != null && !(m.c === c && m.r === r);
}

/** Merge the normalized rectangle into one cell. Absorbs any intersecting
 *  merges and drops the covered cells' contents (the anchor's value survives).
 *  Returns false for a single-cell rectangle (nothing to merge). */
function mergeRange(t, c0, r0, c1, r1) {
  const cc0 = Math.min(c0, c1), rr0 = Math.min(r0, r1);
  const cc1 = Math.max(c0, c1), rr1 = Math.max(r0, r1);
  if (cc0 === cc1 && rr0 === rr1) return false;
  t.merges = t.merges.filter(
    (m) => !(m.c <= cc1 && m.c + m.cw - 1 >= cc0 && m.r <= rr1 && m.r + m.rh - 1 >= rr0),
  );
  for (let r = rr0; r <= rr1; r++) {
    for (let c = cc0; c <= cc1; c++) {
      if (!(c === cc0 && r === rr0)) t.cells.delete(addr(c, r));
    }
  }
  t.merges.push({ c: cc0, r: rr0, cw: cc1 - cc0 + 1, rh: rr1 - rr0 + 1 });
  return true;
}

/** Remove the merge covering (c, r), if any. Returns whether one was removed. */
function unmergeAt(t, c, r) {
  const m = mergeAt(t, c, r);
  if (!m) return false;
  t.merges = t.merges.filter((x) => x !== m);
  return true;
}

const doc = { sheets: [], active: 0 };

/** Lowest free `TableN` across the whole document (names are document-unique). */
function autoTableName() {
  const used = new Set();
  for (const s of doc.sheets) for (const t of s.tables) used.add(t.name);
  let n = 1;
  while (used.has(`Table${n}`)) n++;
  return `Table${n}`;
}

function newSheet() {
  const s = { name: `Sheet${doc.sheets.length + 1}`, tables: [] };
  doc.sheets.push(s);
  s.tables.push(makeTable(autoTableName()));
  return s;
}

const activeSheet = () => doc.sheets[doc.active];

function tableById(id) {
  for (const s of doc.sheets) for (const t of s.tables) if (t.id === id) return t;
  return null;
}

/** Resolve a table by its namespace name anywhere in the document. */
function tableByName(name) {
  const key = name.trim().toLowerCase();
  for (const s of doc.sheets) for (const t of s.tables) {
    if (t.name.toLowerCase() === key) return t;
  }
  return null;
}

function sheetIndexOfTable(t) {
  return doc.sheets.findIndex((s) => s.tables.includes(t));
}

const selTable = () => tableById(selected.tableId);
const getRaw = (t, a) => t.cells.get(a) ?? "";
function setRaw(t, a, raw) {
  if (raw === "") t.cells.delete(a);
  else t.cells.set(a, raw);
}

/** Rename a table. Returns false (leaving the name unchanged) if invalid or
 *  colliding — table names are document-unique namespaces and must not contain
 *  whitespace or the `.` namespace separator. */
function renameTable(t, name) {
  name = name.trim();
  if (name === t.name) return true;
  if (name === "" || /[\s.]/.test(name)) return false;
  if (tableByName(name)) return false; // collision (case-insensitive)
  t.name = name;
  return true;
}

newSheet();

// ---- DOM refs & state -------------------------------------------------------

const sheetEl = document.getElementById("sheet");
const nameBox = document.getElementById("name-box");
const formulaInput = document.getElementById("formula-input");
const tabsEl = document.getElementById("sheet-tabs");

let selected = { tableId: activeSheet().tables[0].id, c: 0, r: 0 };
let anchor = { c: 0, r: 0 }; // other corner of the multi-cell selection
let editing = false;

const focusSheet = () => sheetEl.focus();

/** The current selection rectangle [c0, r0, c1, r1] (anchor ↔ focus), normalized. */
function normRange() {
  return [
    Math.min(anchor.c, selected.c), Math.min(anchor.r, selected.r),
    Math.max(anchor.c, selected.c), Math.max(anchor.r, selected.r),
  ];
}

// ---- rendering --------------------------------------------------------------

function renderSheet() {
  sheetEl.replaceChildren();
  for (const t of activeSheet().tables) sheetEl.append(buildTableCard(t));
  fitCanvas();
}

/** Grow the sheet so every floating table (and some slack) stays scrollable. */
function fitCanvas() {
  let w = 0, h = 0;
  for (const card of sheetEl.querySelectorAll(".table-card")) {
    w = Math.max(w, card.offsetLeft + card.offsetWidth);
    h = Math.max(h, card.offsetTop + card.offsetHeight);
  }
  sheetEl.style.minWidth = `${w + 40}px`;
  sheetEl.style.minHeight = `${h + 40}px`;
}

function buildTableCard(t) {
  const card = el("div", "table-card");
  card.dataset.tableId = t.id;
  card.style.left = `${t.x}px`;
  card.style.top = `${t.y}px`;
  card.style.zIndex = String(t.z);

  const name = el("div", "table-name", t.name);
  name.title = "Drag to move · double-click to rename (name is its namespace)";
  name.addEventListener("dblclick", () => beginRename(t, name));
  name.addEventListener("pointerdown", (e) => startDrag(t, card, e));
  card.append(name);

  const grid = el("section", "grid");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", `Table ${t.name}`);
  grid.dataset.tableId = t.id;
  grid.style.setProperty("--cols", t.cols);
  grid.style.setProperty("--rows", t.rows);

  // No row/column header bands: the table name is the namespace and every cell
  // still has an address (A1, B3, …) shown in the name box, so cells stay
  // specifiable without visible labels. Cells sit on explicit grid lines so
  // skipping a merge's covered cells never shifts the layout.
  t.cellEls.clear();
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      if (isCovered(t, c, r)) continue; // hidden under a merge's anchor
      const a = addr(c, r);
      const cell = el("div", "cell");
      cell.dataset.addr = a;
      cell.dataset.tableId = t.id;
      cell.setAttribute("role", "gridcell");
      const m = mergeAt(t, c, r); // here m, if present, is anchored at (c, r)
      cell.style.gridColumn = `${c + 1}${m ? ` / span ${m.cw}` : ""}`;
      cell.style.gridRow = `${r + 1}${m ? ` / span ${m.rh}` : ""}`;
      if (m) cell.classList.add("merged");
      t.cellEls.set(a, cell);
      grid.append(cell);
      paint(t, a);
    }
  }

  card.append(grid);
  return card;
}

function paint(t, a) {
  const cell = t.cellEls.get(a);
  if (!cell) return;
  const raw = getRaw(t, a);
  cell.textContent = raw;
  cell.dataset.kind = kindOf(raw);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** The address a coordinate resolves to for display/editing: a merge's anchor,
 *  or the cell itself. */
function resolvedAddr(t, c, r) {
  const m = mergeAt(t, c, r);
  return m ? addr(m.c, m.r) : addr(c, r);
}

function renderSelection() {
  for (const c of document.querySelectorAll(".cell.selected, .cell.in-range")) {
    c.classList.remove("selected", "in-range");
  }
  const t = selTable();
  if (!t) return;
  const [c0, r0, c1, r1] = normRange();
  if (c0 !== c1 || r0 !== r1) {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) t.cellEls.get(resolvedAddr(t, c, r))?.classList.add("in-range");
    }
  }
  const a = resolvedAddr(t, selected.c, selected.r);
  t.cellEls.get(a)?.classList.add("selected");
  nameBox.value = `${t.name}.${a}`; // namespaced address, e.g. Table1.B3
  if (!editing) formulaInput.value = getRaw(t, a);
}

// ---- selection & navigation -------------------------------------------------

/** Move the focus cell to (c, r) in a table. With `extend`, keep the current
 *  anchor (growing the selection); otherwise collapse the anchor onto the focus. */
function select(c, r, tableId = selected.tableId, extend = false) {
  const prevTable = selected.tableId;
  const t = tableById(tableId) ?? selTable();
  selected = {
    tableId: t.id,
    c: Math.max(0, Math.min(t.cols - 1, c)),
    r: Math.max(0, Math.min(t.rows - 1, r)),
  };
  if (!extend || t.id !== prevTable) anchor = { c: selected.c, r: selected.r };
  renderSelection();
  t.cellEls.get(resolvedAddr(t, selected.c, selected.r))
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Arrow-key move that steps over merged regions so the focus never lands on a
 *  hidden covered cell (it jumps past the merge in the travel direction). */
function moveFocus(dc, dr, extend = false) {
  const t = selTable();
  let c = selected.c + dc, r = selected.r + dr;
  const m = mergeAt(t, c, r);
  if (m) {
    if (dc > 0) c = m.c + m.cw; else if (dc < 0) c = m.c - 1;
    if (dr > 0) r = m.r + m.rh; else if (dr < 0) r = m.r - 1;
  }
  select(c, r, selected.tableId, extend);
}

/** Resolve a `Table.A1` or bare `A1` reference and jump there, switching sheets
 *  if the named table lives on another one. Returns whether it resolved. */
function jumpTo(text) {
  text = text.trim();
  const dot = text.lastIndexOf(".");
  let t = selTable();
  let addrText = text;
  if (dot >= 0) {
    t = tableByName(text.slice(0, dot));
    addrText = text.slice(dot + 1);
    if (!t) return false;
    const si = sheetIndexOfTable(t);
    if (si !== doc.active) switchSheet(si);
  }
  const p = parseCellAddr(addrText, t);
  if (!p) return false;
  select(p.c, p.r, t.id);
  return true;
}

// ---- editing ----------------------------------------------------------------

function beginEdit(initial) {
  editing = true;
  const t = selTable();
  const a = resolvedAddr(t, selected.c, selected.r);
  const cell = t.cellEls.get(a);
  cell.classList.add("editing");
  cell.contentEditable = "plaintext-only";
  cell.textContent = initial != null ? initial : getRaw(t, a);
  cell.focus();
  // caret to end
  const sel = getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  sel.addRange(range);
}

function commitEdit(move) {
  if (!editing) return;
  const t = selTable();
  const a = resolvedAddr(t, selected.c, selected.r);
  const cell = t.cellEls.get(a);
  setRaw(t, a, cell.textContent.replace(/\n/g, "").trim());
  endEditDom(cell);
  paint(t, a);
  if (move) moveFocus(move.dc, move.dr);
  else renderSelection();
  focusSheet();
}

function cancelEdit() {
  if (!editing) return;
  const t = selTable();
  const a = resolvedAddr(t, selected.c, selected.r);
  const cell = t.cellEls.get(a);
  endEditDom(cell);
  paint(t, a);
  renderSelection();
  focusSheet();
}

function endEditDom(cell) {
  editing = false;
  cell.contentEditable = "false";
  cell.classList.remove("editing");
}

// ---- table renaming ---------------------------------------------------------

function beginRename(t, nameEl) {
  let done = false;
  nameEl.contentEditable = "plaintext-only";
  nameEl.classList.add("editing");
  nameEl.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  sel.addRange(range);

  const finish = (commit) => {
    if (done) return;
    done = true;
    nameEl.contentEditable = "false";
    nameEl.classList.remove("editing");
    if (commit) renameTable(t, nameEl.textContent.replace(/\n/g, ""));
    nameEl.textContent = t.name; // reflect the accepted name (reverts if rejected)
    renderSelection(); // name box may show this table's namespace
    focusSheet();
  };

  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  nameEl.addEventListener("blur", () => finish(true), { once: true });
}

// ---- events -----------------------------------------------------------------

sheetEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // left button selects; right button opens the menu
  const cell = e.target.closest(".cell");
  if (!cell) return;
  if (editing) commitEdit();
  const t = tableById(cell.dataset.tableId);
  const p = t && parseCellAddr(cell.dataset.addr, t);
  // Shift-click extends the selection (within the same table); plain click resets it.
  if (p) select(p.c, p.r, t.id, e.shiftKey && t.id === selected.tableId);
});

sheetEl.addEventListener("dblclick", (e) => {
  if (e.target.closest(".cell")) beginEdit();
});

// Right-click a cell to merge/unmerge; right-click the empty sheet to add a
// table (with a chosen size). Right-clicking a table's name header is left alone
// (so it stays a plain drag handle).
sheetEl.addEventListener("contextmenu", (e) => {
  const cellEl = e.target.closest(".cell");
  if (cellEl) {
    e.preventDefault();
    const t = tableById(cellEl.dataset.tableId);
    const p = parseCellAddr(cellEl.dataset.addr, t);
    // If the click is outside the current selection, collapse onto this cell.
    const [c0, r0, c1, r1] = normRange();
    const inRange = t.id === selected.tableId && p.c >= c0 && p.c <= c1 && p.r >= r0 && p.r <= r1;
    if (!inRange) select(p.c, p.r, t.id);
    openCellMenu(e.clientX, e.clientY, t, p);
    return;
  }
  if (e.target.closest(".table-card")) return;
  e.preventDefault();
  openTableMenu(e.clientX, e.clientY);
});

// Dismiss the menu on any pointer-down outside it.
document.addEventListener("pointerdown", (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeTableMenu();
});

sheetEl.addEventListener("keydown", (e) => {
  if (editing) {
    if (e.key === "Enter") { e.preventDefault(); commitEdit({ dc: 0, dr: 1 }); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    else if (e.key === "Tab") { e.preventDefault(); commitEdit({ dc: e.shiftKey ? -1 : 1, dr: 0 }); }
    return;
  }
  switch (e.key) {
    case "ArrowUp": e.preventDefault(); moveFocus(0, -1, e.shiftKey); break;
    case "ArrowDown": e.preventDefault(); moveFocus(0, 1, e.shiftKey); break;
    case "ArrowLeft": e.preventDefault(); moveFocus(-1, 0, e.shiftKey); break;
    case "ArrowRight": e.preventDefault(); moveFocus(1, 0, e.shiftKey); break;
    case "Enter": e.preventDefault(); beginEdit(); break;
    case "Tab": e.preventDefault(); moveFocus(e.shiftKey ? -1 : 1, 0); break;
    case "F2": e.preventDefault(); beginEdit(); break;
    case "Backspace":
    case "Delete": {
      e.preventDefault();
      clearSelection();
      break;
    }
    default:
      // A printable key starts a fresh edit, replacing the cell (spreadsheet convention).
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        beginEdit(e.key);
      }
  }
});

// Name box: type a namespaced (`Table.A1`) or bare (`A1`) reference, Enter jumps.
nameBox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (jumpTo(nameBox.value)) focusSheet();
  else renderSelection();
});

// Formula bar mirrors and edits the selected cell.
formulaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const t = selTable();
    const a = resolvedAddr(t, selected.c, selected.r);
    setRaw(t, a, formulaInput.value.trim());
    paint(t, a);
    moveFocus(0, 1);
    focusSheet();
  } else if (e.key === "Escape") {
    renderSelection();
    focusSheet();
  }
});

/** Clear every cell in the current selection rectangle (resolving merges). */
function clearSelection() {
  const t = selTable();
  const [c0, r0, c1, r1] = normRange();
  const done = new Set();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const a = resolvedAddr(t, c, r);
      if (done.has(a)) continue;
      done.add(a);
      setRaw(t, a, "");
      paint(t, a);
    }
  }
  renderSelection();
}

// ---- tables & sheet tabs ----------------------------------------------------

/** Create a table of the given size at sheet-content coordinates (x, y). */
function addTableAt(cols, rows, x, y) {
  if (editing) commitEdit();
  const t = makeTable(autoTableName(), cols, rows, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
  activeSheet().tables.push(t);
  renderSheet();
  select(0, 0, t.id);
  focusSheet();
}

// ---- drag to reposition -----------------------------------------------------

function startDrag(t, card, e) {
  if (e.button !== 0) return; // left button only; right-click is the add menu

  const startX = e.clientX, startY = e.clientY;
  const origX = t.x, origY = t.y;
  let dragging = false; // only after the pointer moves past a small threshold,
                        // so a plain double-click still reaches beginRename.

  const onMove = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      if (editing) commitEdit();
      closeTableMenu();
      t.z = ++zTop;
      card.style.zIndex = String(t.z);
      card.classList.add("dragging");
      card.setPointerCapture(e.pointerId);
    }
    t.x = Math.max(0, origX + (ev.clientX - startX));
    t.y = Math.max(0, origY + (ev.clientY - startY));
    card.style.left = `${t.x}px`;
    card.style.top = `${t.y}px`;
  };
  const onUp = () => {
    if (dragging) {
      card.releasePointerCapture(e.pointerId);
      card.classList.remove("dragging");
      fitCanvas();
    }
    card.removeEventListener("pointermove", onMove);
    card.removeEventListener("pointerup", onUp);
  };
  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerup", onUp);
}

// ---- right-click "new table" menu -------------------------------------------

let ctxMenu = null;

function openTableMenu(clientX, clientY) {
  closeTableMenu();
  // Where the table lands, in sheet-content coordinates (not viewport).
  const rect = sheetEl.getBoundingClientRect();
  const dropX = clientX - rect.left;
  const dropY = clientY - rect.top;

  const menu = el("div", "ctx-menu");
  menu.append(el("div", "ctx-title", "New table"));

  const field = (labelText, value, max) => {
    const label = el("label", "ctx-field");
    label.append(el("span", null, labelText));
    const input = el("input");
    input.type = "number";
    input.min = "1";
    input.max = String(max);
    input.value = String(value);
    label.append(input);
    menu.append(label);
    return input;
  };
  const colIn = field("Columns", DEFAULT_COLS, MAX_COLS);
  const rowIn = field("Rows", DEFAULT_ROWS, MAX_ROWS);

  const create = el("button", "ctx-create", "Create");
  const submit = () => {
    addTableAt(
      clampInt(colIn.value, 1, MAX_COLS, DEFAULT_COLS),
      clampInt(rowIn.value, 1, MAX_ROWS, DEFAULT_ROWS),
      dropX, dropY,
    );
    closeTableMenu();
  };
  create.addEventListener("click", submit);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); closeTableMenu(); focusSheet(); }
  });
  menu.append(create);

  placeMenu(menu, clientX, clientY);
  colIn.focus();
  colIn.select();
}

function closeTableMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

/** Place an already-populated menu near the cursor, kept inside the viewport. */
function placeMenu(menu, clientX, clientY) {
  document.body.append(menu);
  ctxMenu = menu;
  menu.style.left = `${Math.max(8, Math.min(clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, innerHeight - menu.offsetHeight - 8))}px`;
}

// ---- right-click cell menu (merge / unmerge) --------------------------------

function openCellMenu(clientX, clientY, t, p) {
  closeTableMenu();
  const menu = el("div", "ctx-menu");

  const [c0, r0, c1, r1] = normRange();
  const rangeCells = t.id === selected.tableId ? (c1 - c0 + 1) * (r1 - r0 + 1) : 1;
  const merge = mergeAt(t, p.c, p.r);

  const item = (label, enabled, onClick) => {
    const b = el("button", "ctx-item", label);
    b.disabled = !enabled;
    if (enabled) b.addEventListener("click", onClick);
    menu.append(b);
    return b;
  };

  item("Merge cells", rangeCells > 1, () => {
    if (mergeRange(t, c0, r0, c1, r1)) {
      renderSheet();
      select(c0, r0, t.id); // selection collapses onto the new merged cell
      focusSheet();
    }
    closeTableMenu();
  });
  item("Unmerge cells", merge != null, () => {
    unmergeAt(t, p.c, p.r);
    renderSheet();
    select(p.c, p.r, t.id);
    focusSheet();
    closeTableMenu();
  });

  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeTableMenu(); focusSheet(); }
  });
  placeMenu(menu, clientX, clientY);
}

function renderTabs() {
  tabsEl.replaceChildren();
  doc.sheets.forEach((s, i) => {
    const b = el("button", null, s.name);
    b.setAttribute("aria-selected", String(i === doc.active));
    b.addEventListener("click", () => switchSheet(i));
    tabsEl.append(b);
  });
  const add = el("button", "add", "+");
  add.setAttribute("aria-label", "Add sheet");
  add.addEventListener("click", addSheet);
  tabsEl.append(add);
}

function switchSheet(i) {
  if (editing) commitEdit();
  doc.active = i;
  renderSheet();
  renderTabs();
  select(0, 0, activeSheet().tables[0].id);
}

function addSheet() {
  newSheet();
  switchSheet(doc.sheets.length - 1);
}

// ---- boot -------------------------------------------------------------------

renderSheet();
renderTabs();
select(0, 0, activeSheet().tables[0].id);
focusSheet();
