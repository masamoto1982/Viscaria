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
// free-floating position (x, y) on the sheet, a stacking order (z), and a
// sparse map of address → raw text. Table names are document-unique namespaces;
// `cellEls` is transient render state (rebuilt each render), not part of the
// document.

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
  cellEls: new Map(),
});

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
let editing = false;

const focusSheet = () => sheetEl.focus();

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

  grid.append(el("div", "corner"));
  for (let c = 0; c < t.cols; c++) grid.append(el("div", "colhead", colLabel(c)));

  t.cellEls.clear();
  for (let r = 0; r < t.rows; r++) {
    grid.append(el("div", "rowhead", String(r + 1)));
    for (let c = 0; c < t.cols; c++) {
      const a = addr(c, r);
      const cell = el("div", "cell");
      cell.dataset.addr = a;
      cell.dataset.tableId = t.id;
      cell.setAttribute("role", "gridcell");
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

function renderSelection() {
  for (const c of document.querySelectorAll(".cell.selected")) c.classList.remove("selected");
  const t = selTable();
  if (!t) return;
  const a = addr(selected.c, selected.r);
  t.cellEls.get(a)?.classList.add("selected");
  nameBox.value = `${t.name}.${a}`; // namespaced address, e.g. Table1.B3
  if (!editing) formulaInput.value = getRaw(t, a);
}

// ---- selection & navigation -------------------------------------------------

function select(c, r, tableId = selected.tableId) {
  const t = tableById(tableId) ?? selTable();
  selected = {
    tableId: t.id,
    c: Math.max(0, Math.min(t.cols - 1, c)),
    r: Math.max(0, Math.min(t.rows - 1, r)),
  };
  renderSelection();
  t.cellEls.get(addr(selected.c, selected.r))?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  const a = addr(selected.c, selected.r);
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
  const a = addr(selected.c, selected.r);
  const cell = t.cellEls.get(a);
  setRaw(t, a, cell.textContent.replace(/\n/g, "").trim());
  endEditDom(cell);
  paint(t, a);
  if (move) select(selected.c + move.dc, selected.r + move.dr);
  else renderSelection();
  focusSheet();
}

function cancelEdit() {
  if (!editing) return;
  const t = selTable();
  const a = addr(selected.c, selected.r);
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
  const cell = e.target.closest(".cell");
  if (!cell) return;
  if (editing) commitEdit();
  const t = tableById(cell.dataset.tableId);
  const p = t && parseCellAddr(cell.dataset.addr, t);
  if (p) select(p.c, p.r, t.id);
});

sheetEl.addEventListener("dblclick", (e) => {
  if (e.target.closest(".cell")) beginEdit();
});

// Right-click the empty sheet to add a table (with a chosen size) there.
// Right-clicking on an existing table is left alone.
sheetEl.addEventListener("contextmenu", (e) => {
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
    case "ArrowUp": e.preventDefault(); select(selected.c, selected.r - 1); break;
    case "ArrowDown": e.preventDefault(); select(selected.c, selected.r + 1); break;
    case "ArrowLeft": e.preventDefault(); select(selected.c - 1, selected.r); break;
    case "ArrowRight": e.preventDefault(); select(selected.c + 1, selected.r); break;
    case "Enter": e.preventDefault(); beginEdit(); break;
    case "Tab": e.preventDefault(); select(selected.c + (e.shiftKey ? -1 : 1), selected.r); break;
    case "F2": e.preventDefault(); beginEdit(); break;
    case "Backspace":
    case "Delete": {
      e.preventDefault();
      const t = selTable();
      const a = addr(selected.c, selected.r);
      setRaw(t, a, "");
      paint(t, a);
      renderSelection();
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
    setRaw(t, addr(selected.c, selected.r), formulaInput.value.trim());
    paint(t, addr(selected.c, selected.r));
    select(selected.c, selected.r + 1);
    focusSheet();
  } else if (e.key === "Escape") {
    renderSelection();
    focusSheet();
  }
});

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

  document.body.append(menu);
  ctxMenu = menu;
  // Keep the menu inside the viewport.
  const lx = Math.max(8, Math.min(clientX, innerWidth - menu.offsetWidth - 8));
  const ly = Math.max(8, Math.min(clientY, innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${lx}px`;
  menu.style.top = `${ly}px`;
  colIn.focus();
  colIn.select();
}

function closeTableMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
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
