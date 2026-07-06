// Viscaria playground — nested-cell shell (five-level cell hierarchy).
//
// Basic-design change: a sheet no longer holds several named *tables*. Instead
// it holds a forest of nested *cells*. A parent cell (階層1) can hold several
// child cells (子, 階層2); a child can hold grandchildren (孫, 階層3); a
// grandchild can hold great-grandchildren (ひ孫, 階層4); a great-grandchild can
// hold great-great-grandchildren (玄孫, 階層5). Five levels total, so a
// great-great-grandchild is always a leaf.
//
// Every cell except a parent (階層1) can be moved by drag & drop in the normal
// state: drop a cell onto another cell to make it that cell's child (move),
// respecting the five-level cap; drop it onto the empty canvas to promote it to
// a parent. Double-click a cell to rewrite its value.
//
// The Ajisai model is kept: everything is internally an exact real (a continued
// fraction, handled by the Rust core; wired through WASM in a later slice), and
// the human-facing surface — the cell's raw text — is separated from that
// internal representation. In Viscaria the cell itself plays the role that the
// Input area, the stack area, and the Output area play in classic Ajisai. The
// raw text here is deliberately *not* evaluated in JS floats, because exactness
// is the whole point.

const MAX_DEPTH = 5;
// Level labels (階層1..5), for the name box breadcrumb and menus.
const LEVEL_JA = ["", "親", "子", "孫", "ひ孫", "玄孫"];

const numberRe = /^-?(\d+(\.\d+)?|\d+\/\d+)$/;
const kindOf = (raw) => (raw !== "" && numberRe.test(raw.trim()) ? "number" : "text");

// ---- model ------------------------------------------------------------------
//
// doc → sheets → roots (a forest of cells). A cell owns a raw value (its
// human-facing surface, separate from the internal exact-real representation)
// and an ordered list of child cells. Depth is positional (a cell's level is
// how deep it sits in the forest, 1..5), so it is not stored on the cell.

let idSeq = 0;
const makeCell = (value = "") => ({ id: `c${++idSeq}`, value, children: [] });

const doc = { sheets: [], active: 0 };

function newSheet() {
  const s = { name: `Sheet${doc.sheets.length + 1}`, roots: [] };
  doc.sheets.push(s);
  s.roots.push(makeCell()); // seed each sheet with one empty parent cell
  return s;
}

const activeSheet = () => doc.sheets[doc.active];

// ---- tree index (rebuilt each render) ---------------------------------------
//
// Maps a cell id to its structural context: the cell, its parent (null for a
// root/parent cell), the sibling list it lives in, its 0-based position there,
// its depth (1..5), and its 1-based path from the root (for the name box).

let index = new Map();

function reindex() {
  index = new Map();
  const walk = (cell, parent, siblings, pos, depth, path) => {
    index.set(cell.id, { cell, parent, siblings, pos, depth, path });
    cell.children.forEach((ch, i) => walk(ch, cell, cell.children, i, depth + 1, [...path, i + 1]));
  };
  activeSheet().roots.forEach((c, i) => walk(c, null, activeSheet().roots, i, 1, [i + 1]));
}

const ctx = (id) => index.get(id) ?? null;

/** The height (number of levels) of the subtree rooted at `cell` — 1 for a leaf. */
function subtreeHeight(cell) {
  if (!cell.children.length) return 1;
  return 1 + Math.max(...cell.children.map(subtreeHeight));
}

/** True iff `maybeAncestorId` is `cellId` or an ancestor of it (so we never drop
 *  a cell into its own subtree). */
function isSelfOrAncestor(maybeAncestorId, cellId) {
  let cur = ctx(cellId);
  while (cur) {
    if (cur.cell.id === maybeAncestorId) return true;
    cur = cur.parent ? ctx(cur.parent.id) : null;
  }
  return false;
}

/** Detach a cell from its current siblings and return it. */
function detach(id) {
  const c = ctx(id);
  if (!c) return null;
  c.siblings.splice(c.pos, 1);
  return c.cell;
}

newSheet();

// ---- DOM refs & state -------------------------------------------------------

const sheetEl = document.getElementById("sheet");
const nameBox = document.getElementById("name-box");
const formulaInput = document.getElementById("formula-input");
const tabsEl = document.getElementById("sheet-tabs");

let selectedId = activeSheet().roots[0].id;
let editing = false;

const focusSheet = () => sheetEl.focus();

// ---- rendering --------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderSheet() {
  reindex();
  // Keep the selection valid across structural edits (deletions, sheet switch).
  if (!index.has(selectedId)) {
    selectedId = activeSheet().roots[0]?.id ?? null;
  }
  sheetEl.replaceChildren();
  for (const root of activeSheet().roots) sheetEl.append(buildCell(root, 1));
  renderSelection();
}

function buildCell(cell, depth) {
  const box = el("div", "cell-box");
  box.dataset.id = cell.id;
  box.dataset.depth = String(depth);
  if (depth > 1) box.draggable = true; // every cell but a parent can be moved

  const val = el("div", "cell-value", cell.value);
  val.dataset.kind = kindOf(cell.value);
  if (cell.value === "") val.classList.add("blank");
  box.append(val);

  if (cell.children.length) {
    const kids = el("div", "cell-children");
    for (const ch of cell.children) kids.append(buildCell(ch, depth + 1));
    box.append(kids);
  }
  return box;
}

const boxOf = (id) => sheetEl.querySelector(`.cell-box[data-id="${id}"]`);

function renderSelection() {
  for (const b of sheetEl.querySelectorAll(".cell-box.selected")) b.classList.remove("selected");
  const c = ctx(selectedId);
  if (!c) {
    nameBox.value = "";
    if (!editing) formulaInput.value = "";
    return;
  }
  boxOf(selectedId)?.classList.add("selected");
  // Breadcrumb: 親1 › 子2 › 孫1 … (level label + 1-based position per depth).
  nameBox.value = c.path.map((n, i) => `${LEVEL_JA[i + 1] ?? "?"}${n}`).join(" › ");
  if (!editing) formulaInput.value = c.cell.value;
}

// ---- selection & navigation -------------------------------------------------

function select(id) {
  if (!ctx(id)) return;
  selectedId = id;
  renderSelection();
  boxOf(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Tree navigation: up/down = previous/next sibling, right = first child,
 *  left = parent. */
function moveSelection(key) {
  const c = ctx(selectedId);
  if (!c) return;
  switch (key) {
    case "ArrowUp": if (c.pos > 0) select(c.siblings[c.pos - 1].id); break;
    case "ArrowDown": if (c.pos < c.siblings.length - 1) select(c.siblings[c.pos + 1].id); break;
    case "ArrowRight": if (c.cell.children.length) select(c.cell.children[0].id); break;
    case "ArrowLeft": if (c.parent) select(c.parent.id); break;
  }
}

// ---- editing ----------------------------------------------------------------

function beginEdit(initial) {
  const c = ctx(selectedId);
  if (!c) return;
  editing = true;
  const val = boxOf(selectedId)?.querySelector(".cell-value");
  if (!val) { editing = false; return; }
  val.classList.remove("blank");
  val.contentEditable = "plaintext-only";
  val.classList.add("editing");
  val.textContent = initial != null ? initial : c.cell.value;
  val.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(val);
  range.collapse(false);
  sel.addRange(range);
}

function commitEdit() {
  if (!editing) return;
  const c = ctx(selectedId);
  const val = boxOf(selectedId)?.querySelector(".cell-value");
  editing = false;
  if (c && val) c.cell.value = val.textContent.replace(/\n/g, "").trim();
  renderSheet();
  focusSheet();
}

function cancelEdit() {
  if (!editing) return;
  editing = false;
  renderSheet();
  focusSheet();
}

// ---- structural edits -------------------------------------------------------

/** Add an empty child under a cell, if it is not already at the deepest level. */
function addChild(id) {
  const c = ctx(id);
  if (!c || c.depth >= MAX_DEPTH) return;
  const child = makeCell();
  c.cell.children.push(child);
  renderSheet();
  select(child.id);
}

/** Add a new empty parent cell (階層1) to the active sheet. */
function addParent() {
  const p = makeCell();
  activeSheet().roots.push(p);
  renderSheet();
  select(p.id);
}

/** Remove a cell (and its subtree). A sheet keeps at least one parent cell. */
function removeCell(id) {
  const c = ctx(id);
  if (!c) return;
  if (c.depth === 1 && activeSheet().roots.length <= 1) return; // keep one parent
  detach(id);
  selectedId = c.parent ? c.parent.id : (activeSheet().roots[0]?.id ?? null);
  renderSheet();
}

// ---- drag & drop (move a cell) ----------------------------------------------
//
// Drop a dragged cell onto a target cell to make it that cell's last child
// (respecting the five-level cap: the target's depth + 1 plus the dragged
// subtree's height must not exceed MAX_DEPTH, and a cell can't be dropped into
// its own subtree). Drop onto the empty canvas to promote it to a parent.

let dragId = null;

/** Whether the dragged cell may become a child at `newDepth` (1 = parent). */
function fitsAt(cell, newDepth) {
  return newDepth >= 1 && newDepth + subtreeHeight(cell) - 1 <= MAX_DEPTH;
}

sheetEl.addEventListener("dragstart", (e) => {
  const box = e.target.closest(".cell-box");
  if (!box || box.dataset.depth === "1") return; // parents don't move
  if (editing) commitEdit();
  dragId = box.dataset.id;
  box.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
});

sheetEl.addEventListener("dragend", () => {
  dragId = null;
  for (const b of sheetEl.querySelectorAll(".drop-target, .dragging")) {
    b.classList.remove("drop-target", "dragging");
  }
});

sheetEl.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const dragged = ctx(dragId)?.cell;
  if (!dragged) return;
  const box = e.target.closest(".cell-box");
  for (const b of sheetEl.querySelectorAll(".drop-target")) b.classList.remove("drop-target");

  if (box) {
    const targetId = box.dataset.id;
    const t = ctx(targetId);
    // Not into its own subtree, and the whole subtree must still fit.
    if (!t || isSelfOrAncestor(dragId, targetId) || !fitsAt(dragged, t.depth + 1)) return;
    e.preventDefault();
    box.classList.add("drop-target");
  } else {
    // Empty canvas → promote to parent (階層1) if the subtree fits.
    if (!fitsAt(dragged, 1)) return;
    e.preventDefault();
    sheetEl.classList.add("drop-target");
  }
});

sheetEl.addEventListener("dragleave", (e) => {
  if (e.target === sheetEl) sheetEl.classList.remove("drop-target");
});

sheetEl.addEventListener("drop", (e) => {
  if (!dragId) return;
  const dragged = ctx(dragId)?.cell;
  if (!dragged) return;
  const box = e.target.closest(".cell-box");
  sheetEl.classList.remove("drop-target");

  if (box) {
    const targetId = box.dataset.id;
    const t = ctx(targetId);
    if (!t || isSelfOrAncestor(dragId, targetId) || !fitsAt(dragged, t.depth + 1)) return;
    e.preventDefault();
    const moved = detach(dragId);
    t.cell.children.push(moved); // reindex below resolves t.cell by identity
    renderSheet();
    select(moved.id);
  } else {
    if (!fitsAt(dragged, 1)) return;
    e.preventDefault();
    const moved = detach(dragId);
    activeSheet().roots.push(moved);
    renderSheet();
    select(moved.id);
  }
});

// ---- pointer & keyboard events ----------------------------------------------

// A click selects the innermost cell under the pointer; a double-click edits it.
// Listening on the value element's `.cell-box` via closest keeps a child click
// from also selecting its ancestors.
sheetEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const box = e.target.closest(".cell-box");
  if (!box) return;
  if (editing) commitEdit();
  select(box.dataset.id);
});

sheetEl.addEventListener("dblclick", (e) => {
  const box = e.target.closest(".cell-box");
  if (!box) return;
  select(box.dataset.id);
  beginEdit();
});

sheetEl.addEventListener("contextmenu", (e) => {
  const box = e.target.closest(".cell-box");
  e.preventDefault();
  if (box) {
    select(box.dataset.id);
    openCellMenu(e.clientX, e.clientY, box.dataset.id);
  } else {
    openCanvasMenu(e.clientX, e.clientY);
  }
});

document.addEventListener("pointerdown", (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeMenu();
});

sheetEl.addEventListener("keydown", (e) => {
  if (editing) {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
    return;
  }
  switch (e.key) {
    case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight":
      e.preventDefault(); moveSelection(e.key); break;
    case "Enter": case "F2": e.preventDefault(); beginEdit(); break;
    case "Backspace": case "Delete": e.preventDefault(); removeCell(selectedId); break;
    default:
      // A printable key starts a fresh edit, replacing the value.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        beginEdit(e.key);
      }
  }
});

// Formula bar mirrors and edits the selected cell's value.
formulaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const c = ctx(selectedId);
    if (c) c.cell.value = formulaInput.value.trim();
    renderSheet();
    focusSheet();
  } else if (e.key === "Escape") {
    renderSelection();
    focusSheet();
  }
});

// ---- context menus ----------------------------------------------------------

let ctxMenu = null;

function closeMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

function placeMenu(menu, clientX, clientY) {
  document.body.append(menu);
  ctxMenu = menu;
  menu.style.left = `${Math.max(8, Math.min(clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, innerHeight - menu.offsetHeight - 8))}px`;
}

function menuItem(menu, label, enabled, onClick) {
  const b = el("button", "ctx-item", label);
  b.disabled = !enabled;
  if (enabled) b.addEventListener("click", () => { onClick(); closeMenu(); focusSheet(); });
  menu.append(b);
  return b;
}

function openCellMenu(clientX, clientY, id) {
  closeMenu();
  const c = ctx(id);
  if (!c) return;
  const menu = el("div", "ctx-menu");
  const childLabel = c.depth < MAX_DEPTH ? `${LEVEL_JA[c.depth + 1]}セルを追加` : "最深階層（追加不可）";
  menuItem(menu, childLabel, c.depth < MAX_DEPTH, () => addChild(id));
  const deletable = !(c.depth === 1 && activeSheet().roots.length <= 1);
  menuItem(menu, "このセルを削除", deletable, () => removeCell(id));
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); focusSheet(); }
  });
  placeMenu(menu, clientX, clientY);
}

function openCanvasMenu(clientX, clientY) {
  closeMenu();
  const menu = el("div", "ctx-menu");
  menuItem(menu, "親セルを追加", true, addParent);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); focusSheet(); }
  });
  placeMenu(menu, clientX, clientY);
}

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
  selectedId = activeSheet().roots[0]?.id ?? null;
  renderSheet();
  renderTabs();
}

function addSheet() {
  newSheet();
  switchSheet(doc.sheets.length - 1);
}

// ---- boot -------------------------------------------------------------------

renderSheet();
renderTabs();
select(activeSheet().roots[0].id);
focusSheet();
