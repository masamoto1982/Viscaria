// Viscaria playground — grid shell (first slice).
//
// Scope of this slice: a Numbers/Sheets-style square-cell grid with selection,
// in-cell and formula-bar editing, keyboard navigation, and multiple sheets.
// Cells hold literal values (numbers / text); numbers right-align. Formula
// evaluation (`=A1+B1`) with EXACT continued-fraction arithmetic is the next
// slice, wired through the Rust core compiled to WASM — deliberately not faked
// in JS floats here, because exactness is the whole point.

const COLS = 10;
const ROWS = 24;

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

/** "B3" → {c, r} (0-based), or null. */
function parseAddr(text) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(text.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  const r = parseInt(m[2], 10) - 1;
  c -= 1;
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
  return { c, r };
}

const numberRe = /^-?(\d+(\.\d+)?|\d+\/\d+)$/;
const kindOf = (raw) => (raw !== "" && numberRe.test(raw.trim()) ? "number" : "text");

// ---- model ------------------------------------------------------------------

/** One sheet: a name plus a sparse map of address → raw text. */
const makeSheet = (name) => ({ name, cells: new Map() });

const doc = { sheets: [makeSheet("Sheet1")], active: 0 };
const sheet = () => doc.sheets[doc.active];
const getRaw = (a) => sheet().cells.get(a) ?? "";
function setRaw(a, raw) {
  if (raw === "") sheet().cells.delete(a);
  else sheet().cells.set(a, raw);
}

// ---- DOM refs & state -------------------------------------------------------

const gridEl = document.getElementById("grid");
const nameBox = document.getElementById("name-box");
const formulaInput = document.getElementById("formula-input");
const tabsEl = document.getElementById("sheet-tabs");

let selected = { c: 0, r: 0 };
let editing = false;
const cellEls = new Map(); // addr → element

// ---- rendering --------------------------------------------------------------

function buildGrid() {
  gridEl.style.setProperty("--cols", COLS);
  gridEl.style.setProperty("--rows", ROWS);
  gridEl.replaceChildren();
  cellEls.clear();

  const corner = el("div", "corner");
  gridEl.append(corner);
  for (let c = 0; c < COLS; c++) gridEl.append(el("div", "colhead", colLabel(c)));

  for (let r = 0; r < ROWS; r++) {
    gridEl.append(el("div", "rowhead", String(r + 1)));
    for (let c = 0; c < COLS; c++) {
      const a = addr(c, r);
      const cell = el("div", "cell");
      cell.dataset.addr = a;
      cell.setAttribute("role", "gridcell");
      cellEls.set(a, cell);
      paint(a);
      gridEl.append(cell);
    }
  }
}

function paint(a) {
  const cell = cellEls.get(a);
  if (!cell) return;
  const raw = getRaw(a);
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
  for (const c of cellEls.values()) c.classList.remove("selected");
  const a = addr(selected.c, selected.r);
  cellEls.get(a)?.classList.add("selected");
  nameBox.value = a;
  if (!editing) formulaInput.value = getRaw(a);
}

// ---- selection & navigation -------------------------------------------------

function select(c, r) {
  selected = {
    c: Math.max(0, Math.min(COLS - 1, c)),
    r: Math.max(0, Math.min(ROWS - 1, r)),
  };
  renderSelection();
  cellEls.get(addr(selected.c, selected.r))?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---- editing ----------------------------------------------------------------

function beginEdit(initial) {
  editing = true;
  const a = addr(selected.c, selected.r);
  const cell = cellEls.get(a);
  cell.classList.add("editing");
  cell.contentEditable = "plaintext-only";
  cell.textContent = initial != null ? initial : getRaw(a);
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
  const a = addr(selected.c, selected.r);
  const cell = cellEls.get(a);
  setRaw(a, cell.textContent.replace(/\n/g, "").trim());
  endEditDom(cell);
  paint(a);
  if (move) select(selected.c + move.dc, selected.r + move.dr);
  else renderSelection();
  gridEl.focus();
}

function cancelEdit() {
  if (!editing) return;
  const a = addr(selected.c, selected.r);
  const cell = cellEls.get(a);
  endEditDom(cell);
  paint(a);
  renderSelection();
  gridEl.focus();
}

function endEditDom(cell) {
  editing = false;
  cell.contentEditable = "false";
  cell.classList.remove("editing");
}

// ---- events -----------------------------------------------------------------

gridEl.addEventListener("mousedown", (e) => {
  const cell = e.target.closest(".cell");
  if (!cell) return;
  if (editing) commitEdit();
  const p = parseAddr(cell.dataset.addr);
  if (p) select(p.c, p.r);
});

gridEl.addEventListener("dblclick", (e) => {
  if (e.target.closest(".cell")) beginEdit();
});

gridEl.addEventListener("keydown", (e) => {
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
    case "Delete":
      e.preventDefault();
      setRaw(addr(selected.c, selected.r), "");
      paint(addr(selected.c, selected.r));
      renderSelection();
      break;
    default:
      // A printable key starts a fresh edit, replacing the cell (spreadsheet convention).
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        beginEdit(e.key);
      }
  }
});

// Name box: type an address, Enter jumps.
nameBox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const p = parseAddr(nameBox.value);
  if (p) { select(p.c, p.r); gridEl.focus(); }
  else renderSelection();
});

// Formula bar mirrors and edits the selected cell.
formulaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    setRaw(addr(selected.c, selected.r), formulaInput.value.trim());
    paint(addr(selected.c, selected.r));
    select(selected.c, selected.r + 1);
    gridEl.focus();
  } else if (e.key === "Escape") {
    renderSelection();
    gridEl.focus();
  }
});

// ---- sheet tabs -------------------------------------------------------------

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
  for (const a of cellEls.keys()) paint(a);
  renderTabs();
  select(0, 0);
}

function addSheet() {
  doc.sheets.push(makeSheet(`Sheet${doc.sheets.length + 1}`));
  switchSheet(doc.sheets.length - 1);
}

// ---- boot -------------------------------------------------------------------

buildGrid();
renderTabs();
select(0, 0);
gridEl.focus();
