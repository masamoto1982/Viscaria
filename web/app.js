// Viscaria playground — five-level nested cell cards.
//
// The document is a forest of nested cells five levels deep — 親 (level 1) →
// 子 → 孫 → ひ孫 → 玄孫. There is no sheet wrapper: the board is the document,
// and 親 cells sit directly on it.
//
// Every cell is a *card* with two faces:
//
//   Front (the normal view) — a leaf cell (no children) IS its value: the
//   whole card face shows the value, editable with a double-click. A cell
//   with children shows its children instead, filling the card: the nested
//   cells ARE its visible content, with no caption strip above them.
//
//   Back — the cell's *name* lives here (double-click to rename), together
//   with the add-child (＋) and delete (×) controls. Flipping hides the
//   front entirely — children included — exactly like turning over a card.
//
// Right-click a cell that isn't selected and it just selects; right-click it
// again now that it's selected and the card flips over. Right-click the empty
// board to add a new 親 cell.
//
// Every cell except a 親 can be moved by drag & drop: drop it onto another
// cell to nest it there (the five-level cap and self-subtree checks are
// enforced), or onto the empty board to promote it to a 親. Dragging is
// pointer-event based, not native HTML5 drag & drop — nested `draggable`
// elements make the browser pick the wrong ancestor. Positions and sizes
// snap to a visible dot grid, and every cell has a corner resize handle,
// since a cell's size is what makes room to build cells inside it.
//
// The Ajisai model is kept: everything is internally an exact real (a
// continued fraction, handled by the Rust core; wired through WASM in a later
// slice), and the human-facing surface — the raw text a cell shows — is
// separate from that internal representation. In Viscaria the cell itself
// plays the role that the Input area, the stack area, and the Output area
// play in classic Ajisai. Raw text is deliberately *not* evaluated in JS
// floats here, because exactness is the whole point.

const MAX_DEPTH = 5;
// Positional level labels (階層1..5) — the breadcrumb fallback for unnamed cells.
const LEVEL_JA = ["", "親", "子", "孫", "ひ孫", "玄孫"];

// Grid-snap and sizing constants (px). GRID must match `--grid` in styles.css.
const GRID = 16;
const DEFAULT_W = 160; // 10 grid units
const DEFAULT_H = 96; // 6 grid units
const MIN_W = 64;
const MIN_H = 48;
const PAD = 8; // margin kept around children when auto-placing / growing

const snap = (v) => Math.max(0, Math.round(v / GRID) * GRID);

const numberRe = /^-?(\d+(\.\d+)?|\d+\/\d+)$/;
const kindOf = (raw) => (raw !== "" && numberRe.test(raw.trim()) ? "number" : "text");

// ---- model ------------------------------------------------------------------
//
// doc.roots is the forest of 親 cells. A cell owns a name (its back-face
// label), a raw value (its human-facing surface, separate from the internal
// exact-real representation), an ordered list of child cells, a grid-snapped
// position (x, y) relative to its parent's front face (meaningful for depth
// ≥ 2 only — 親 cells flow on the board), a grid-snapped size (w, h), and
// whether the card is currently showing its back (`flipped`).

let idSeq = 0;
const makeCell = () => ({
  id: `c${++idSeq}`,
  name: "",
  value: "",
  children: [],
  x: 0,
  y: 0,
  w: DEFAULT_W,
  h: DEFAULT_H,
  flipped: false,
});

const doc = { roots: [makeCell()] };

// ---- tree index (rebuilt each render) ----------------------------------------
//
// Maps a cell id to its structural context: the cell, its parent (null for a
// 親), the sibling list it lives in, its 0-based position there, its depth
// (1..5), and the trail of cells from the root down to it (for the breadcrumb).

let index = new Map();

function reindex() {
  index = new Map();
  const walk = (cell, parent, siblings, pos, depth, trail) => {
    index.set(cell.id, { cell, parent, siblings, pos, depth, trail });
    cell.children.forEach((ch, i) => walk(ch, cell, cell.children, i, depth + 1, [...trail, ch]));
  };
  doc.roots.forEach((c, i) => walk(c, null, doc.roots, i, 1, [c]));
}

const ctx = (id) => index.get(id) ?? null;

/** Height (number of levels) of the subtree rooted at `cell` — 1 for a leaf. */
function subtreeHeight(cell) {
  if (!cell.children.length) return 1;
  return 1 + Math.max(...cell.children.map(subtreeHeight));
}

/** True iff `maybeAncestorId` is `cellId` or an ancestor of it. */
function isSelfOrAncestor(maybeAncestorId, cellId) {
  for (let cur = ctx(cellId); cur; cur = cur.parent ? ctx(cur.parent.id) : null) {
    if (cur.cell.id === maybeAncestorId) return true;
  }
  return false;
}

/** Whether `cell`'s subtree may live with its root at `newDepth` (1 = 親). */
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

/** Grow a cell so its front face contains its children's bounding box —
 *  a freshly added or dropped-in child must never be invisible outside it. */
function growToFit(cell) {
  if (!cell.children.length) return;
  cell.w = Math.max(cell.w, ...cell.children.map((ch) => ch.x + ch.w + PAD));
  cell.h = Math.max(cell.h, ...cell.children.map((ch) => ch.y + ch.h + PAD));
}

/** Minimum size a cell may be resized to: a floor, or (with children) big
 *  enough to keep the children's bounding box inside. */
function minSizeFor(cell) {
  return {
    minW: Math.max(MIN_W, ...cell.children.map((ch) => ch.x + ch.w + PAD)),
    minH: Math.max(MIN_H, ...cell.children.map((ch) => ch.y + ch.h + PAD)),
  };
}

// ---- DOM refs & state ---------------------------------------------------------

const boardEl = document.getElementById("board");
const nameBox = document.getElementById("name-box");
const formulaInput = document.getElementById("formula-input");

let selectedId = doc.roots[0].id;
let editing = null; // { id, field: "value" | "name" } while an in-cell edit is live

const focusBoard = () => boardEl.focus();

// ---- rendering ------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const boxOf = (id) => boardEl.querySelector(`.cell-box[data-id="${id}"]`);

/** The editable element for (id, field), scoped to that cell's own faces so a
 *  descendant cell's elements can never be picked up by mistake. */
function editableEl(id, field) {
  const sel = field === "value"
    ? ':scope > .card > .face.front > .cell-value'
    : ':scope > .card > .face.back > .cell-name';
  return boxOf(id)?.querySelector(sel) ?? null;
}

function renderBoard() {
  reindex();
  if (!index.has(selectedId)) selectedId = doc.roots[0]?.id ?? null;
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
    box.classList.add("positioned");
    box.style.left = `${cell.x}px`;
    box.style.top = `${cell.y}px`;
  }
  if (cell.flipped) box.classList.add("flipped");

  const card = el("div", "card");

  // Front: a leaf shows its value across the whole face; a cell with children
  // shows the children canvas instead (the children ARE the visible content).
  const front = el("div", "face front");
  if (cell.children.length === 0) {
    const val = el("div", "cell-value", cell.value);
    val.dataset.kind = kindOf(cell.value);
    val.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      select(cell.id);
      beginEdit(cell.id, "value");
    });
    front.append(val);
  } else {
    const kids = el("div", "cell-children");
    for (const ch of cell.children) kids.append(buildCell(ch, depth + 1));
    front.append(kids);
  }
  card.append(front);

  // Back: the cell's name plus the structural controls. Rendering it even
  // while hidden keeps flipping a pure CSS class toggle.
  const back = el("div", "face back");
  const name = el("div", "cell-name", cell.name);
  name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    select(cell.id);
    beginEdit(cell.id, "name");
  });
  back.append(name);

  const buttons = el("div", "face-buttons");
  const addBtn = el("button", "face-btn", "＋");
  addBtn.title = depth < MAX_DEPTH ? `${LEVEL_JA[depth + 1]}セルを追加` : "最深階層（追加不可）";
  addBtn.disabled = depth >= MAX_DEPTH;
  addBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  addBtn.addEventListener("click", (e) => { e.stopPropagation(); addChild(cell.id); });
  const delBtn = el("button", "face-btn danger", "×");
  delBtn.title = "このセルを削除";
  delBtn.disabled = depth === 1 && doc.roots.length <= 1;
  delBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  delBtn.addEventListener("click", (e) => { e.stopPropagation(); removeCell(cell.id); });
  buttons.append(addBtn, delBtn);
  back.append(buttons);
  card.append(back);

  box.append(card);

  const handle = el("div", "resize-handle");
  handle.setAttribute("aria-hidden", "true");
  box.append(handle);
  attachResize(handle, box, cell);

  attachFlip(box, cell);
  if (depth > 1) attachDrag(box, cell);
  else attachSelectOnly(box, cell);

  return box;
}

function renderSelection() {
  for (const b of boardEl.querySelectorAll(".cell-box.selected")) b.classList.remove("selected");
  const c = ctx(selectedId);
  if (!c) {
    nameBox.value = "";
    if (!editing) formulaInput.value = "";
    return;
  }
  boxOf(selectedId)?.classList.add("selected");
  // Breadcrumb of names; an unnamed cell falls back to its positional label
  // (親1, 子2, …). E.g. 請求書 › 子1 › 単価.
  nameBox.value = c.trail
    .map((cell, i) => cell.name || `${LEVEL_JA[i + 1] ?? "?"}${(ctx(cell.id)?.pos ?? 0) + 1}`)
    .join(" › ");
  if (!editing) formulaInput.value = c.cell.value;
}

// ---- selection & navigation -----------------------------------------------------

function select(id) {
  if (!ctx(id)) return;
  selectedId = id;
  renderSelection();
  boxOf(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Tree navigation: up/down = previous/next sibling, right = first child
 *  (only when visible, i.e. not flipped), left = parent. */
function moveSelection(key) {
  const c = ctx(selectedId);
  if (!c) return;
  switch (key) {
    case "ArrowUp": if (c.pos > 0) select(c.siblings[c.pos - 1].id); break;
    case "ArrowDown": if (c.pos < c.siblings.length - 1) select(c.siblings[c.pos + 1].id); break;
    case "ArrowRight": if (!c.cell.flipped && c.cell.children.length) select(c.cell.children[0].id); break;
    case "ArrowLeft": if (c.parent) select(c.parent.id); break;
  }
}

// ---- in-cell editing (value on the front, name on the back) ----------------------

function beginEdit(id, field, initial) {
  if (editing) commitEdit();
  const target = editableEl(id, field);
  if (!target) return;
  editing = { id, field };
  target.classList.add("editing");
  target.contentEditable = "plaintext-only";
  if (initial != null) target.textContent = initial;
  target.focus();
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function commitEdit() {
  if (!editing) return;
  const { id, field } = editing;
  const c = ctx(id);
  const target = editableEl(id, field);
  editing = null;
  if (c && target) c.cell[field] = target.textContent.replace(/\n/g, "").trim();
  renderBoard();
  focusBoard();
}

function cancelEdit() {
  if (!editing) return;
  editing = null;
  renderBoard();
  focusBoard();
}

// ---- structural edits ------------------------------------------------------------

/** Add an empty child, placed to the right of its last sibling (or at the
 *  top-left corner if first). The parent grows to fit and shows its front so
 *  the new child is immediately visible. */
function addChild(id) {
  const c = ctx(id);
  if (!c || c.depth >= MAX_DEPTH) return;
  const last = c.cell.children[c.cell.children.length - 1];
  const child = makeCell();
  child.x = last ? snap(last.x + last.w + PAD) : PAD;
  child.y = last ? last.y : PAD;
  c.cell.children.push(child);
  growToFit(c.cell);
  c.cell.flipped = false;
  renderBoard();
  select(child.id);
}

/** Add a new empty 親 cell to the board. */
function addParent() {
  const p = makeCell();
  doc.roots.push(p);
  renderBoard();
  select(p.id);
}

/** Remove a cell and its subtree. The board keeps at least one 親. */
function removeCell(id) {
  const c = ctx(id);
  if (!c) return;
  if (c.depth === 1 && doc.roots.length <= 1) return;
  detach(id);
  selectedId = c.parent ? c.parent.id : (doc.roots[0]?.id ?? null);
  renderBoard();
}

// ---- resize (pointer-driven, grid-snapped) -----------------------------------------

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

// ---- card flip ---------------------------------------------------------------------
//
// Right-click on a not-yet-selected cell just selects it (look before you
// flip); right-click it again once selected and the card turns over.

function attachFlip(box, cell) {
  box.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation(); // innermost cell wins; also keeps the board menu shut
    closeMenu();
    if (editing) commitEdit();
    if (selectedId === cell.id) {
      cell.flipped = !cell.flipped;
      renderBoard();
      select(cell.id);
      boxOf(cell.id)?.classList.add("flipping"); // one-shot turn animation
    } else {
      select(cell.id);
    }
  });
}

// ---- drag & drop (pointer-driven move / reparent) -----------------------------------
//
// Pointer events, not native HTML5 draggable: nested draggable elements make
// the browser pick the outermost ancestor. Per-cell pointerdown listeners all
// sit on the same DOM path, so each handler stops propagation — the innermost
// cell under the pointer is the one that acts.

/** What's under the pointer: a cell, the bare board, or nothing. */
function dropCandidateAt(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  const boxEl = hit.closest(".cell-box");
  if (boxEl) return { kind: "cell", id: boxEl.dataset.id };
  if (hit.closest("#board")) return { kind: "board" };
  return null;
}

function dropIsValid(cand, dragged, draggedId) {
  if (!cand) return false;
  if (cand.kind === "board") return fitsAt(dragged, 1);
  const t = ctx(cand.id);
  return t != null && !isSelfOrAncestor(draggedId, cand.id) && fitsAt(dragged, t.depth + 1);
}

/** Where a drop into cell `id` measures from: its children canvas when it has
 *  one, otherwise the cell's own box (a leaf about to become a parent). Both
 *  the mid-drag ghost and the final landing use this same origin, so the
 *  position seen during the drag is exactly where the cell lands. */
function dropOriginRect(id) {
  const box = boxOf(id);
  if (!box) return null;
  const area = box.querySelector(":scope > .card > .face.front > .cell-children");
  return (area ?? box).getBoundingClientRect();
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
    if (e.target.closest(".editing")) return; // caret placement inside a live edit
    if (e.target.closest(".resize-handle, .face-btn")) return;
    e.stopPropagation();
    closeMenu(); // the doc-level click-outside close never sees this event now
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
        box.style.pointerEvents = "none"; // elementFromPoint must see beneath it
        box.setPointerCapture(e.pointerId);
      }
      const cand = dropCandidateAt(ev.clientX, ev.clientY);
      const valid = dropIsValid(cand, cell, cell.id);
      highlightDropTarget(valid ? cand : null);
      // Over a valid cell the ghost sticks to that cell's grid — the drag
      // itself snaps, not just the release. Over the board (promotion to 親,
      // which flows rather than being positioned) it follows the pointer.
      let left = ev.clientX - grabDX;
      let top = ev.clientY - grabDY;
      if (valid && cand.kind === "cell") {
        const origin = dropOriginRect(cand.id);
        if (origin) {
          left = origin.left + Math.max(0, snap(left - origin.left));
          top = origin.top + Math.max(0, snap(top - origin.top));
        }
      }
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
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
    // Landing position: the same grid-snapped origin the mid-drag ghost used,
    // so the cell lands exactly where the drag showed it.
    const originRect = dropOriginRect(cand.id);
    const moved = detach(draggedId);
    if (originRect) {
      moved.x = Math.max(0, snap(clientX - grabDX - originRect.left));
      moved.y = Math.max(0, snap(clientY - grabDY - originRect.top));
    }
    t.cell.children.push(moved);
    growToFit(t.cell);
    t.cell.flipped = false; // show the front so the drop result is visible
    renderBoard();
    select(moved.id);
    return;
  }
  renderBoard(); // invalid drop: re-render snaps the ghost back
  select(draggedId);
}

/** A 親 can't be dragged, but it still selects on click. */
function attachSelectOnly(box, cell) {
  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".editing")) return;
    if (e.target.closest(".resize-handle, .face-btn")) return;
    e.stopPropagation();
    closeMenu();
    if (editing) commitEdit();
    select(cell.id);
  });
}

// ---- board-level events --------------------------------------------------------------

// A right-click that lands on a cell is handled (and stopped) by that cell's
// own flip listener, so this only fires for the bare board.
boardEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openBoardMenu(e.clientX, e.clientY);
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
  const c = ctx(selectedId);
  // The keyboard edits whatever the selected card currently shows: the name
  // when flipped, the value when it's a leaf front. (A non-leaf front shows
  // children — nothing of its own to type into.)
  const field = c?.cell.flipped ? "name" : (c && c.cell.children.length === 0 ? "value" : null);
  switch (e.key) {
    case "ArrowUp": case "ArrowDown": case "ArrowLeft": case "ArrowRight":
      e.preventDefault(); moveSelection(e.key); break;
    case "Enter": case "F2":
      e.preventDefault();
      if (field) beginEdit(selectedId, field);
      break;
    case "Backspace": case "Delete":
      e.preventDefault(); removeCell(selectedId); break;
    default:
      if (field && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        beginEdit(selectedId, field, e.key);
      }
  }
});

// The formula bar mirrors and edits the selected cell's *value* (its name is
// a label, not content — rename on the card's back).
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

// ---- board context menu ("add a 親 cell") ---------------------------------------------

let ctxMenu = null;

function closeMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

function openBoardMenu(clientX, clientY) {
  closeMenu();
  const menu = el("div", "ctx-menu");
  const item = el("button", "ctx-item", "親セルを追加");
  item.addEventListener("click", () => { addParent(); closeMenu(); focusBoard(); });
  menu.append(item);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); focusBoard(); }
  });
  document.body.append(menu);
  ctxMenu = menu;
  menu.style.left = `${Math.max(8, Math.min(clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, innerHeight - menu.offsetHeight - 8))}px`;
}

// ---- boot ------------------------------------------------------------------------------

renderBoard();
select(doc.roots[0].id);
focusBoard();
