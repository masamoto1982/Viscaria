// Viscaria playground — nested-cell shell (five-level cell hierarchy).
//
// The document is a forest of nested cells five levels deep — parent (親,
// level 1) → child (子) → grandchild (孫) → great-grandchild (ひ孫) →
// great-great-grandchild (玄孫). There is no sheet wrapper: a sheet would sit
// above the parent level and make the hierarchy read as six levels instead of
// five, so the board *is* the document (no tabs, no multiple sheets).
//
// Every cell except a parent (階層1) can be moved by drag & drop in the normal
// state: drag it and drop it onto another cell to make it that cell's child
// (move), respecting the five-level cap; drop it onto the empty board to
// promote it to a parent. Dragging is implemented with pointer events (not
// native HTML5 drag & drop) because nested `draggable` elements make the
// browser pick the wrong ancestor to drag — pointer events give full control
// over hit-testing and the five-level depth guard. A dropped/resized cell's
// position and size snap to a grid so nested layouts stay tidy.
//
// Every cell (including a parent) can be resized via a corner handle — a cell
// with children needs room to lay them out, so its size is the thing that
// makes "build cells inside cells" practical.
//
// Double-click a cell to rewrite its value.
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

// Grid-snap and sizing constants (px). GRID must match `--grid` in styles.css
// (the dot-grid background that makes the snap increment visible).
const GRID = 16;
const DEFAULT_W = 160;
const DEFAULT_H = 96;
const MIN_W = 64;
const MIN_H = 48;
const PAD = 8; // inner margin used when auto-placing/growing for new children
const VALUE_RESERVE = 34; // approx rendered height of the value line, for sizing math

const snap = (v) => Math.max(0, Math.round(v / GRID) * GRID);

const numberRe = /^-?(\d+(\.\d+)?|\d+\/\d+)$/;
const kindOf = (raw) => (raw !== "" && numberRe.test(raw.trim()) ? "number" : "text");

// ---- model ------------------------------------------------------------------
//
// doc.roots is a forest of cells — no sheet wrapper. A cell owns a raw value
// (its human-facing surface, separate from the internal exact-real
// representation), an ordered list of child cells, and a position (x, y) +
// size (w, h) in pixels, all grid-snapped. Position is only meaningful for a
// depth ≥ 2 cell — it is relative to its parent's children area; a parent
// (depth 1) flows in the board instead of being positioned, since parents
// cannot be dragged.

let idSeq = 0;
const makeCell = (value = "", w = DEFAULT_W, h = DEFAULT_H) => ({
  id: `c${++idSeq}`,
  value,
  children: [],
  x: 0,
  y: 0,
  w,
  h,
});

const doc = { roots: [] };
doc.roots.push(makeCell()); // seed the document with one empty parent cell

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
  doc.roots.forEach((c, i) => walk(c, null, doc.roots, i, 1, [i + 1]));
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

/** Whether a dragged cell may become a child at `newDepth` (1 = parent),
 *  respecting the five-level cap. */
function fitsAt(cell, newDepth) {
  return newDepth >= 1 && newDepth + subtreeHeight(cell) - 1 <= MAX_DEPTH;
}

/** Detach a cell from its current siblings and return it. */
function detach(id) {
  const c = ctx(id);
  if (!c) return null;
  c.siblings.splice(c.pos, 1);
  return c.cell;
}

/** Grow a cell so its own box fully contains its children's bounding box (used
 *  after adding or reparenting a child) — the point of resizing is moot if a
 *  freshly-added child is invisible outside the box. */
function growToFit(cell) {
  if (!cell.children.length) return;
  const maxX = Math.max(...cell.children.map((ch) => ch.x + ch.w));
  const maxY = Math.max(...cell.children.map((ch) => ch.y + ch.h));
  cell.w = Math.max(cell.w, maxX + PAD);
  cell.h = Math.max(cell.h, VALUE_RESERVE + maxY + PAD);
}

/** The minimum (w, h) a cell may be resized to: a floor, or (if it has
 *  children) big enough to keep its children's bounding box inside. */
function minSizeFor(cell) {
  let minW = MIN_W, minH = MIN_H;
  if (cell.children.length) {
    const maxX = Math.max(...cell.children.map((ch) => ch.x + ch.w));
    const maxY = Math.max(...cell.children.map((ch) => ch.y + ch.h));
    minW = Math.max(minW, maxX + PAD);
    minH = Math.max(minH, VALUE_RESERVE + maxY + PAD);
  }
  return { minW, minH };
}

// ---- DOM refs & state -------------------------------------------------------

const boardEl = document.getElementById("board");
const nameBox = document.getElementById("name-box");
const formulaInput = document.getElementById("formula-input");

let selectedId = doc.roots[0].id;
let editing = false;

const focusBoard = () => boardEl.focus();

// ---- rendering --------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderBoard() {
  reindex();
  // Keep the selection valid across structural edits (deletions).
  if (!index.has(selectedId)) {
    selectedId = doc.roots[0]?.id ?? null;
  }
  boardEl.replaceChildren();
  for (const root of doc.roots) boardEl.append(buildCell(root, 1));
  renderSelection();
}

function buildCell(cell, depth) {
  const box = el("div", "cell-box");
  box.dataset.id = cell.id;
  box.dataset.depth = String(depth);
  box.style.width = `${cell.w}px`;
  box.style.height = `${cell.h}px`;
  if (depth > 1) {
    // Depth ≥ 2 cells are grid-positioned within their parent's children area;
    // a parent (depth 1) flows in the board instead (it cannot be dragged).
    box.classList.add("positioned");
    box.style.left = `${cell.x}px`;
    box.style.top = `${cell.y}px`;
  }

  const val = el("div", "cell-value", cell.value);
  val.dataset.kind = kindOf(cell.value);
  if (cell.value === "") val.classList.add("blank");
  box.append(val);

  if (depth < MAX_DEPTH) {
    const kids = el("div", "cell-children");
    for (const ch of cell.children) kids.append(buildCell(ch, depth + 1));
    box.append(kids);
  }

  const handle = el("div", "resize-handle");
  handle.setAttribute("aria-hidden", "true");
  box.append(handle);
  attachResize(handle, box, cell);

  if (depth > 1) attachDrag(box, cell);
  else attachSelectOnly(box, cell);

  return box;
}

const boxOf = (id) => boardEl.querySelector(`.cell-box[data-id="${id}"]`);

function renderSelection() {
  for (const b of boardEl.querySelectorAll(".cell-box.selected")) b.classList.remove("selected");
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
  renderBoard();
  focusBoard();
}

function cancelEdit() {
  if (!editing) return;
  editing = false;
  renderBoard();
  focusBoard();
}

// ---- structural edits -------------------------------------------------------

/** Add an empty child under a cell, if it is not already at the deepest level.
 *  The new child is placed to the right of its last sibling (or at the
 *  top-left corner if it's the first), and the parent grows to fit it. */
function addChild(id) {
  const c = ctx(id);
  if (!c || c.depth >= MAX_DEPTH) return;
  const siblings = c.cell.children;
  const last = siblings[siblings.length - 1];
  const child = makeCell();
  child.x = last ? last.x + last.w + PAD : PAD;
  child.y = PAD;
  siblings.push(child);
  growToFit(c.cell);
  renderBoard();
  select(child.id);
}

/** Add a new empty parent cell (階層1) to the board. */
function addParent() {
  const p = makeCell();
  doc.roots.push(p);
  renderBoard();
  select(p.id);
}

/** Remove a cell (and its subtree). The board keeps at least one parent cell. */
function removeCell(id) {
  const c = ctx(id);
  if (!c) return;
  if (c.depth === 1 && doc.roots.length <= 1) return; // keep one parent
  detach(id);
  selectedId = c.parent ? c.parent.id : (doc.roots[0]?.id ?? null);
  renderBoard();
}

// ---- resize (pointer-driven, grid-snapped) ----------------------------------

function attachResize(handle, box, cell) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    closeMenu();
    if (editing) commitEdit();
    const startX = e.clientX, startY = e.clientY;
    const origW = cell.w, origH = cell.h;
    const { minW, minH } = minSizeFor(cell);
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      cell.w = Math.max(minW, snap(origW + (ev.clientX - startX)));
      cell.h = Math.max(minH, snap(origH + (ev.clientY - startY)));
      box.style.width = `${cell.w}px`;
      box.style.height = `${cell.h}px`;
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

// ---- drag & drop (pointer-driven move / reparent) ---------------------------
//
// Pointer events (not native HTML5 draggable) so nested cells hit-test
// correctly — the browser's native DnD picks the outermost draggable ancestor,
// which breaks for a cell nested inside another draggable cell. Dropping onto
// a cell nests the dragged cell there (as its last child, grid-snapped
// position); dropping onto empty board promotes it to a parent. Both respect
// the five-level cap and refuse a drop into the dragged cell's own subtree.

/** What's under (clientX, clientY): a specific cell, the board itself, or
 *  nothing (outside the document). */
function dropCandidateAt(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  const boxEl = hit.closest(".cell-box");
  if (boxEl) return { kind: "cell", id: boxEl.dataset.id };
  if (hit.closest("#board")) return { kind: "board" };
  return null;
}

/** Whether `cand` is a legal drop target for `dragged` (depth cap + no
 *  dropping into its own subtree). */
function dropIsValid(cand, dragged, draggedId) {
  if (!cand) return false;
  if (cand.kind === "board") return fitsAt(dragged, 1);
  const t = ctx(cand.id);
  return t != null && !isSelfOrAncestor(draggedId, cand.id) && fitsAt(dragged, t.depth + 1);
}

function clearDropHighlight() {
  for (const b of boardEl.querySelectorAll(".drop-target")) b.classList.remove("drop-target");
  boardEl.classList.remove("drop-target");
}

function highlightDropTarget(cand) {
  clearDropHighlight();
  if (!cand) return;
  if (cand.kind === "board") boardEl.classList.add("drop-target");
  else boxOf(cand.id)?.classList.add("drop-target");
}

function attachDrag(box, cell) {
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".cell-value.editing")) return; // let caret placement work
    if (e.target.closest(".resize-handle")) return;
    // Stop the bubble here: without this, a pointerdown on a nested cell also
    // reaches every ancestor cell-box's own listener (they all sit on the same
    // DOM path), and each one would start its own drag/select for itself.
    e.stopPropagation();
    // With the bubble stopped, the document-level "click outside closes the
    // menu" listener never sees a click that lands on a cell — close it here
    // instead, unconditionally, so a stray menu doesn't linger.
    closeMenu();
    if (editing) commitEdit();

    const startX = e.clientX, startY = e.clientY;
    const rect = box.getBoundingClientRect();
    const grabDX = startX - rect.left, grabDY = startY - rect.top;
    let dragging = false;

    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        box.classList.add("dragging");
        box.style.position = "fixed";
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.pointerEvents = "none"; // so elementFromPoint sees what's beneath it
        box.setPointerCapture(e.pointerId);
      }
      box.style.left = `${ev.clientX - grabDX}px`;
      box.style.top = `${ev.clientY - grabDY}px`;
      const cand = dropCandidateAt(ev.clientX, ev.clientY);
      highlightDropTarget(dropIsValid(cand, cell, cell.id) ? cand : null);
    };
    const onUp = (ev) => {
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      if (!dragging) { select(cell.id); return; }
      box.releasePointerCapture(e.pointerId);
      clearDropHighlight();
      finishDrag(ev.clientX, ev.clientY, cell.id, grabDX, grabDY);
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
  });
}

function finishDrag(clientX, clientY, draggedId, grabDX, grabDY) {
  const dragged = ctx(draggedId)?.cell;
  const cand = dragged ? dropCandidateAt(clientX, clientY) : null;
  if (dragged && dropIsValid(cand, dragged, draggedId)) {
    if (cand.kind === "board") {
      const moved = detach(draggedId);
      doc.roots.push(moved);
      renderBoard();
      select(moved.id);
      return;
    }
    const t = ctx(cand.id);
    const areaRect = boxOf(cand.id)?.querySelector(".cell-children")?.getBoundingClientRect();
    const moved = detach(draggedId);
    if (areaRect) {
      moved.x = Math.max(0, snap(clientX - grabDX - areaRect.left));
      moved.y = Math.max(0, snap(clientY - grabDY - areaRect.top));
    }
    t.cell.children.push(moved);
    growToFit(t.cell);
    renderBoard();
    select(moved.id);
    return;
  }
  renderBoard(); // invalid drop: snap back (re-render discards the fixed-position ghost)
  select(draggedId);
}

/** A depth-1 (parent) cell can't be dragged, but it still selects on click. */
function attachSelectOnly(box, cell) {
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".cell-value.editing")) return;
    if (e.target.closest(".resize-handle")) return;
    e.stopPropagation(); // see the comment in attachDrag
    closeMenu();
    if (editing) commitEdit();
    select(cell.id);
  });
}

// ---- pointer & keyboard events -----------------------------------------------

boardEl.addEventListener("dblclick", (e) => {
  const box = e.target.closest(".cell-box");
  if (!box) return;
  select(box.dataset.id);
  beginEdit();
});

boardEl.addEventListener("contextmenu", (e) => {
  const box = e.target.closest(".cell-box");
  e.preventDefault();
  if (box) {
    select(box.dataset.id);
    openCellMenu(e.clientX, e.clientY, box.dataset.id);
  } else {
    openBoardMenu(e.clientX, e.clientY);
  }
});

document.addEventListener("pointerdown", (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeMenu();
});

boardEl.addEventListener("keydown", (e) => {
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
    renderBoard();
    focusBoard();
  } else if (e.key === "Escape") {
    renderSelection();
    focusBoard();
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
  if (enabled) b.addEventListener("click", () => { onClick(); closeMenu(); focusBoard(); });
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
  const deletable = !(c.depth === 1 && doc.roots.length <= 1);
  menuItem(menu, "このセルを削除", deletable, () => removeCell(id));
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); focusBoard(); }
  });
  placeMenu(menu, clientX, clientY);
}

function openBoardMenu(clientX, clientY) {
  closeMenu();
  const menu = el("div", "ctx-menu");
  menuItem(menu, "親セルを追加", true, addParent);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); focusBoard(); }
  });
  placeMenu(menu, clientX, clientY);
}

// ---- boot -------------------------------------------------------------------

renderBoard();
select(doc.roots[0].id);
focusBoard();
