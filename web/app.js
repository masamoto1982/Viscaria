import { BUILD_TIMESTAMP } from "./version.js";

// Viscaria playground — sheets of paper, cells placed on them.
//
// The document is a set of *sheets*. Each sheet is a sheet of paper of a
// standard office size (A3–B5, portrait or landscape) — a WYSIWYG page in the
// Apple Numbers sense — and you place cells freely on it. The paper is not a
// cell; it is the surface (the depth-0 root of the sheet). The cards on it are
// 親 (level 1), which nest down through 子 → 孫 → ひ孫 → 玄孫 (level 5).
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
// Right-click a card that isn't selected and it just selects; right-click it
// again now that it's selected and the card flips over. Right-click the paper
// to add a 親 cell to it.
//
// Every card can be moved by drag & drop: drop it onto another cell — or onto
// the bare paper — to nest it there (the five-level cap and self-subtree
// checks are enforced). Dragging is pointer-event based, not native HTML5
// drag & drop — nested `draggable` elements make the browser pick the wrong
// ancestor. Positions and sizes snap to a 16px grid (invisible), and every
// card has a corner resize handle; shoving a card flush against a sibling
// kisses their edges so a group tiles into a table.
//
// A sheet's name is a namespace: cross-sheet value references (Google Sheets
// style, `=SheetName!cellName`) are the next slice. This one brings back the
// sheet concept — tabs, rename, per-sheet paper size — and puts cells back on
// the paper as 親.
//
// Viscaria keeps the exact-real model it inherits from Ajisai: everything is
// internally an exact real (a continued fraction, handled by the Rust core;
// wired through WASM in a later slice), and the human-facing surface — the
// raw text a cell shows — is separate from that internal representation. Raw
// text is deliberately *not* evaluated in JS floats here, because exactness
// is the whole point.

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
const BORDER = 1; // cell border width (px) — must match `.cell-box` in styles.css

const snap = (v) => Math.max(0, Math.round(v / GRID) * GRID);

// Standard paper sizes in millimetres (portrait: width × height), rendered at
// 96 CSS px per inch. A3–B5 covers the common office range; B-series is JIS.
const PAPER_SIZES = {
  A3: [297, 420], A4: [210, 297], A5: [148, 210], B4: [257, 364], B5: [182, 257],
};
const PAPER_ORDER = ["A3", "B4", "A4", "B5", "A5"];
const MM_PER_PX = 96 / 25.4; // ≈ 3.7795 px per mm

function paperDims(sheet) {
  const [wmm, hmm] = PAPER_SIZES[sheet.paper] ?? PAPER_SIZES.A4;
  let w = Math.round(wmm * MM_PER_PX), h = Math.round(hmm * MM_PER_PX);
  if (sheet.orientation === "landscape") [w, h] = [h, w];
  return [w, h];
}

// ---- numbers: canonical fractions (Ajisai reuse) ------------------------------
//
// Every number normalizes to Ajisai's canonical fraction form on commit: a
// reduced numerator/denominator pair with the denominator always written, so
// `6/2` → `3/1`, `0.5` → `1/2`, `3` → `3/1`. The arithmetic is BigInt —
// exact, never a float — matching the exact-real principle until the Rust
// core takes over through WASM. Anything that doesn't parse as a number is
// Text and stays as typed.

const integerRe = /^-?\d+$/;
const decimalRe = /^(-?)(\d+)\.(\d+)$/;
const fractionRe = /^(-?\d+)\/(\d+)$/;

const gcd = (a, b) => {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
};

/** The canonical `numerator/denominator` reading of raw text, or null when it
 *  isn't a number (including a zero denominator — that's NIL territory for
 *  the evaluator, not a canonical literal). */
function normalizeNumeric(raw) {
  raw = raw.trim();
  let n, d;
  if (integerRe.test(raw)) {
    n = BigInt(raw);
    d = 1n;
  } else if (decimalRe.test(raw)) {
    const [, sign, intPart, fracPart] = decimalRe.exec(raw);
    d = 10n ** BigInt(fracPart.length);
    n = BigInt(intPart) * d + BigInt(fracPart);
    if (sign === "-") n = -n;
  } else if (fractionRe.test(raw)) {
    const [, num, den] = fractionRe.exec(raw);
    n = BigInt(num);
    d = BigInt(den);
    if (d === 0n) return null;
  } else {
    return null;
  }
  if (n === 0n) return "0/1";
  const g = gcd(n, d);
  return `${n / g}/${d / g}`;
}

/** Normalize a committed value: numbers become canonical fractions, anything
 *  else stays as typed. */
const canonicalize = (raw) => normalizeNumeric(raw) ?? raw.trim();

// A value is a number iff it IS a canonical fraction (committed values
// normalize, so canonical values are fixed points; `1/0` normalizes to null
// and therefore stays text).
const kindOf = (raw) => (normalizeNumeric(raw) === raw.trim() ? "number" : "text");

// ---- LaTeX view (Ajisai's value-latex.ts, ported) -----------------------------
//
// TeX is generated from the canonical numerator/denominator pair, never by
// parsing arbitrary display text. `3/1` reads as the integer 3; a negative
// sign stays outside the bar. Components at or past ten digits switch to an
// exactly-computed scientific reading, prefixed \approx whenever any
// precision is dropped — the math view never presents a truncated value as
// exact. (Constants and logic follow Ajisai's src/gui/value-latex.ts.)

const SCIENTIFIC_DIGIT_THRESHOLD = 10;
const MANTISSA_DIGITS = 6;

function scientificLatex(numerator, denominator) {
  if (denominator < 0n) {
    denominator = -denominator;
    numerator = -numerator;
  }
  const negative = numerator < 0n;
  if (negative) numerator = -numerator;
  if (numerator === 0n) return "0";

  const digitGap = String(numerator).length - String(denominator).length;
  const scale = MANTISSA_DIGITS + 1 - digitGap;
  const scaled = scale >= 0
    ? (numerator * 10n ** BigInt(scale)) / denominator
    : numerator / (denominator * 10n ** BigInt(-scale));
  const dividesExactly = scale >= 0
    ? (numerator * 10n ** BigInt(scale)) % denominator === 0n
    : numerator % (denominator * 10n ** BigInt(-scale)) === 0n;

  const digits = String(scaled);
  const exponent = digits.length - 1 - scale;
  const kept = digits.slice(0, MANTISSA_DIGITS);
  const dropped = digits.slice(MANTISSA_DIGITS);
  const exact = dividesExactly && /^0*$/.test(dropped);

  let significand = kept;
  let exponentOut = exponent;
  if (!exact && dropped.length > 0 && dropped[0] >= "5") {
    const rounded = String(BigInt(kept) + 1n);
    if (rounded.length > kept.length) {
      significand = "1";
      exponentOut = exponent + 1;
    } else {
      significand = rounded;
    }
  }
  significand = significand.replace(/0+$/, "") || "0";

  const sign = negative ? "-" : "";
  let body;
  if (exponentOut >= 0 && exponentOut <= 5) {
    const integerLength = exponentOut + 1;
    const padded = significand.padEnd(integerLength, "0");
    const integerPart = padded.slice(0, integerLength);
    const fractionalPart = padded.slice(integerLength);
    body = `${sign}${integerPart}${fractionalPart ? `.${fractionalPart}` : ""}`;
  } else if (exponentOut < 0 && exponentOut >= -4) {
    body = `${sign}0.${"0".repeat(-exponentOut - 1)}${significand}`;
  } else {
    const mantissa = significand.length > 1
      ? `${significand[0]}.${significand.slice(1)}`
      : significand;
    body = mantissa === "1"
      ? `${sign}10^{${exponentOut}}`
      : `${sign}${mantissa} \\times 10^{${exponentOut}}`;
  }
  return exact ? body : `\\approx ${body}`;
}

/** The LaTeX reading of a canonical `n/d` value string, or null when the
 *  value isn't numeric (text keeps its plain rendering). */
function valueToLatex(raw) {
  const m = fractionRe.exec(raw.trim());
  if (!m) return null;
  const [, num, den] = m;
  if (num.replace("-", "").length >= SCIENTIFIC_DIGIT_THRESHOLD
    || den.length >= SCIENTIFIC_DIGIT_THRESHOLD) {
    return scientificLatex(BigInt(num), BigInt(den));
  }
  if (den === "1") return num;
  const negative = num.startsWith("-");
  const magnitude = negative ? num.slice(1) : num;
  const body = `\\frac{${magnitude}}{${den}}`;
  return negative ? `-${body}` : body;
}

// Opt-in, persisted — the canonical fraction strings stay the standard
// rendering, so the observable surface never depends on KaTeX (Ajisai's
// portability rule).
const LATEX_VIEW_STORAGE_KEY = "viscaria-latex-view";
let latexView = false;
try { latexView = localStorage.getItem(LATEX_VIEW_STORAGE_KEY) === "1"; } catch { /* preference only */ }

// ---- model ------------------------------------------------------------------
//
// doc is a list of sheets. A sheet has a name (its namespace), a paper size +
// orientation, and a `root` cell — the paper surface. The root is not a card:
// it is not rendered as one, its name/value/size/flipped go unused, and only
// its `children` (the 親 cells, depth 1) and its identity as the sheet's
// depth-0 root matter. Every card owns a name (its back-face label), a raw
// value (its human-facing surface, separate from the internal exact-real
// representation), an ordered list of children, a grid-snapped position
// (x, y) within its parent's front face (or on the paper, for a 親), a
// grid-snapped size (w, h), and whether it currently shows its back.

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

let sheetSeq = 0;
const doc = { sheets: [], active: 0 };
function makeSheet(name) {
  return {
    id: `s${++sheetSeq}`,
    name: name ?? `Sheet${doc.sheets.length + 1}`,
    paper: "A4",
    orientation: "portrait",
    root: makeCell(), // the paper surface (depth-0 root); its children are 親
  };
}
doc.sheets.push(makeSheet());

const activeSheet = () => doc.sheets[doc.active];
const paperRoot = () => activeSheet().root;

// ---- tree index (rebuilt each render) ----------------------------------------
//
// Maps a cell id to its structural context: the cell, its parent (null for the
// paper root), the sibling list it lives in, its 0-based position there, its
// depth (0 for the paper, 1..5 for cards), and the trail of nodes from the
// root down to it (for the breadcrumb).

let index = new Map();

function reindex() {
  index = new Map();
  const walk = (cell, parent, siblings, pos, depth, trail) => {
    index.set(cell.id, { cell, parent, siblings, pos, depth, trail });
    cell.children.forEach((ch, i) => walk(ch, cell, cell.children, i, depth + 1, [...trail, ch]));
  };
  // The paper is the depth-0 root; its children are 親 (depth 1) and down.
  const root = paperRoot();
  walk(root, null, [root], 0, 0, [root]);
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
 *  a freshly added or dropped-in child must never be invisible outside it.
 *  The paper root has a fixed size (the page), so it never grows. */
function growToFit(cell) {
  if (cell === paperRoot() || !cell.children.length) return;
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
const tabsEl = document.getElementById("sheet-tabs");
const paperSelect = document.getElementById("paper-size");
const orientBtn = document.getElementById("paper-orient");

let paperEl = null; // the current .paper element (positioning context for 親)
let viewScale = 1; // paper→screen scale (< 1 when the paper is shrunk to fit a phone)
let selectedId = null; // nothing selected until a card is clicked
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
  if (selectedId != null && !index.has(selectedId)) selectedId = null;
  const [pw, ph] = paperDims(activeSheet());
  paperEl = el("div", "paper");
  paperEl.style.width = `${pw}px`;
  paperEl.style.height = `${ph}px`;
  for (const child of paperRoot().children) paperEl.append(buildCell(child, 1));
  // The paper sits in a wrapper sized to its (possibly scaled) footprint, so a
  // narrow screen can shrink the paper to fit while centering and scrolling
  // stay correct.
  const wrap = el("div", "paper-wrap");
  wrap.append(paperEl);
  boardEl.replaceChildren(wrap);
  fitPaperToWidth(pw, ph, wrap);
  renderSelection();
}

/** Fit the paper to the board's width on a narrow screen (Apple Numbers on a
 *  phone): scale it down uniformly so its whole width shows, and size the
 *  wrapper to the scaled footprint. `viewScale` is 1 on a wide screen — the
 *  paper is left untransformed, so the drag ghost (a fixed element) sees no
 *  transformed ancestor and the desktop path is byte-identical. Below 1, every
 *  pointer↔model conversion in the drag/resize code divides or multiplies by
 *  `viewScale` to bridge screen (scaled) and logical (unscaled) coordinates. */
function fitPaperToWidth(pw, ph, wrap) {
  const avail = boardEl.clientWidth;
  viewScale = avail > 0 ? Math.min(1, avail / pw) : 1;
  if (viewScale < 1) {
    paperEl.style.transformOrigin = "top left";
    paperEl.style.transform = `scale(${viewScale})`;
    wrap.style.width = `${Math.round(pw * viewScale)}px`;
    wrap.style.height = `${Math.round(ph * viewScale)}px`;
  } else {
    paperEl.style.transform = "";
    wrap.style.width = `${pw}px`;
    wrap.style.height = `${ph}px`;
  }
}

function buildCell(cell, depth) {
  const box = el("div", "cell-box positioned");
  box.dataset.id = cell.id;
  box.dataset.depth = String(depth);
  // Draw the box one border wider/taller than its logical size (which stays
  // grid-snapped for placement). When a card sits flush against a neighbor
  // (kissed edge-to-edge), this 1px bleed makes their two 1px borders land in
  // the same column/row and paint as a single shared line, instead of two
  // adjacent borders reading as a 2px-thick seam. For an isolated card the
  // extra pixel is invisible.
  box.style.width = `${cell.w + BORDER}px`;
  box.style.height = `${cell.h + BORDER}px`;
  box.style.left = `${cell.x}px`;
  box.style.top = `${cell.y}px`;
  if (cell.flipped) box.classList.add("flipped");

  const card = el("div", "card");

  // Front: a leaf shows its value across the whole face; a cell with children
  // shows the children canvas instead (the children ARE the visible content).
  const front = el("div", "face front");
  if (cell.children.length === 0) {
    const val = el("div", "cell-value", cell.value);
    val.dataset.kind = kindOf(cell.value);
    // Math view: KaTeX rendering of the canonical fraction. Trusted markup —
    // the TeX comes from valueToLatex over the canonical n/d form, never
    // from arbitrary user text (text values keep their plain rendering).
    if (latexView && typeof katex !== "undefined") {
      const tex = valueToLatex(cell.value);
      if (tex !== null) {
        val.replaceChildren();
        val.innerHTML = katex.renderToString(tex, { throwOnError: false });
        val.classList.add("math");
      }
    }
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
  attachDrag(box, cell); // every card is draggable (only the paper is fixed)

  return box;
}

function renderSelection() {
  for (const b of boardEl.querySelectorAll(".cell-box.selected")) b.classList.remove("selected");
  const c = ctx(selectedId);
  if (!c || c.cell === paperRoot()) {
    nameBox.value = "";
    if (!editing) formulaInput.value = "";
    return;
  }
  boxOf(selectedId)?.classList.add("selected");
  // Breadcrumb of names below the paper root. An unnamed cell falls back to
  // its positional label (親1, 子2, …). E.g. 請求書 › 単価.
  nameBox.value = c.trail
    .slice(1) // drop the paper root
    .map((cell) => cell.name || `${LEVEL_JA[ctx(cell.id)?.depth ?? 0] ?? "?"}${(ctx(cell.id)?.pos ?? 0) + 1}`)
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
 *  (only when visible, i.e. not flipped), left = parent (never the paper). */
function moveSelection(key) {
  const c = ctx(selectedId);
  if (!c) return;
  switch (key) {
    case "ArrowUp": if (c.pos > 0) select(c.siblings[c.pos - 1].id); break;
    case "ArrowDown": if (c.pos < c.siblings.length - 1) select(c.siblings[c.pos + 1].id); break;
    case "ArrowRight": if (!c.cell.flipped && c.cell.children.length) select(c.cell.children[0].id); break;
    case "ArrowLeft": if (c.parent && c.parent !== paperRoot()) select(c.parent.id); break;
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
  // Always (re)set the text from the model: in math view the element holds
  // KaTeX markup, and editing must start from the canonical string.
  target.textContent = initial != null ? initial : (ctx(id)?.cell[field] ?? "");
  target.classList.remove("math");
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
  if (c && target) {
    const raw = target.textContent.replace(/\n/g, "").trim();
    // Values normalize to the canonical fraction form (6/2 → 3/1); names
    // are labels and stay as typed.
    c.cell[field] = field === "value" ? canonicalize(raw) : raw;
  }
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

/** Add an empty child, placed one grid unit in from the corner (or one grid
 *  unit right of its last sibling) — on the grid, so flush edge-to-edge
 *  contact between siblings stays on the same lattice. The parent grows to fit
 *  and shows its front so the new child is immediately visible. */
function addChild(id) {
  const c = ctx(id);
  if (!c || c.depth >= MAX_DEPTH) return;
  const last = c.cell.children[c.cell.children.length - 1];
  const child = makeCell();
  child.x = last ? snap(last.x + last.w + GRID) : GRID;
  child.y = last ? last.y : GRID;
  c.cell.children.push(child);
  growToFit(c.cell);
  c.cell.flipped = false;
  renderBoard();
  select(child.id);
}

/** Remove a card and its subtree. The paper root can't be removed. */
function removeCell(id) {
  const c = ctx(id);
  if (!c || c.cell === paperRoot()) return;
  detach(id);
  selectedId = c.parent && c.parent !== paperRoot() ? c.parent.id : null;
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
      // Pointer deltas are screen px; divide by viewScale to get paper px.
      cell.w = Math.max(minW, snap(origW + (ev.clientX - startX) / viewScale));
      cell.h = Math.max(minH, snap(origH + (ev.clientY - startY) / viewScale));
      box.style.width = `${cell.w + BORDER}px`; // +border to match buildCell
      box.style.height = `${cell.h + BORDER}px`;
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
    e.stopPropagation(); // innermost cell wins; also keeps the paper menu shut
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

/** Which target is under the pointer to drop into: a card, the bare paper (a
 *  drop there makes the card a 親), or nothing (off the paper). */
function dropCandidateAt(clientX, clientY) {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  const boxEl = hit.closest(".cell-box");
  if (boxEl) return { id: boxEl.dataset.id };
  if (hit.closest(".paper")) return { id: paperRoot().id };
  return null;
}

function dropIsValid(cand, dragged, draggedId) {
  if (!cand) return false;
  const t = ctx(cand.id);
  return t != null && !isSelfOrAncestor(draggedId, cand.id) && fitsAt(dragged, t.depth + 1);
}

/** Where a drop into `id` measures from: the paper for the paper root, a
 *  card's children canvas when it has one, otherwise the card's own box. Both
 *  the mid-drag ghost and the final landing use this same origin, so the
 *  position seen during the drag is exactly where the cell lands. */
function dropOriginRect(id) {
  if (id === paperRoot().id) return paperEl.getBoundingClientRect();
  const box = boxOf(id);
  if (!box) return null;
  const area = box.querySelector(":scope > .card > .face.front > .cell-children");
  return (area ?? box).getBoundingClientRect();
}

/** Grid-snap (x, y) inside `target`, then resolve contact against the other
 *  children: merely coming near a sibling leaves the grid in charge, but
 *  pushing INTO one snaps the dragged cell flush against its edge — cells
 *  kiss instead of overlapping, so shoving cells together assembles a table.
 *  Resolution pushes out along the axis of least penetration; a few passes
 *  settle corridor cases. Positions stay grid-snapped (flush = sib.x + sib.w),
 *  so a chain of kissed cells stays on one lattice; the coincident 1px seam
 *  between them is handled at render time (buildCell draws each box one border
 *  wider so a flush neighbor's border lands on top of this one's). */
function resolveCellPlacement(target, dragged, x, y) {
  x = snap(x);
  y = snap(y);
  const w = dragged.w, h = dragged.h;
  for (let pass = 0; pass < 4; pass++) {
    let pushed = false;
    for (const sib of target.children) {
      if (sib.id === dragged.id) continue;
      const overlapX = Math.min(x + w, sib.x + sib.w) - Math.max(x, sib.x);
      const overlapY = Math.min(y + h, sib.y + sib.h) - Math.max(y, sib.y);
      if (overlapX <= 0 || overlapY <= 0) continue; // near ≠ touching: grid wins
      if (overlapX <= overlapY) {
        x = x + w / 2 < sib.x + sib.w / 2 ? sib.x - w : sib.x + sib.w;
      } else {
        y = y + h / 2 < sib.y + sib.h / 2 ? sib.y - h : sib.y + sib.h;
      }
      x = Math.max(0, x);
      y = Math.max(0, y);
      pushed = true;
    }
    if (!pushed) break;
  }
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

function clearDropHighlight() {
  for (const b of boardEl.querySelectorAll(".drop-target")) b.classList.remove("drop-target");
}

function highlightDropTarget(cand) {
  clearDropHighlight();
  if (!cand) return;
  (cand.id === paperRoot().id ? paperEl : boxOf(cand.id))?.classList.add("drop-target");
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
        // When the paper is scaled to fit a phone, the ghost must escape the
        // paper's transform (a transformed ancestor is the containing block
        // for a fixed element) — reparent it to the body and scale it itself,
        // so it stays viewport-positioned and matches the on-paper cell size.
        if (viewScale < 1) {
          document.body.append(box);
          box.style.transformOrigin = "top left";
          box.style.transform = `scale(${viewScale})`;
        }
        box.style.left = `${rect.left}px`;
        box.style.top = `${rect.top}px`;
        box.style.pointerEvents = "none"; // elementFromPoint must see beneath it
        box.setPointerCapture(e.pointerId);
      }
      const cand = dropCandidateAt(ev.clientX, ev.clientY);
      const valid = dropIsValid(cand, cell, cell.id);
      highlightDropTarget(valid ? cand : null);
      // Over a valid target — a card or the bare paper — the ghost sticks to
      // that target's grid and kisses sibling edges on contact, so the drag
      // itself snaps, not just the release. Screen offsets divide by viewScale
      // to reach logical (paper) coords; the snapped logical position multiplies
      // back to screen for the ghost.
      let left = ev.clientX - grabDX;
      let top = ev.clientY - grabDY;
      if (valid) {
        const origin = dropOriginRect(cand.id);
        const target = ctx(cand.id)?.cell;
        if (origin && target) {
          const p = resolveCellPlacement(
            target, cell,
            (left - origin.left) / viewScale,
            (top - origin.top) / viewScale,
          );
          left = origin.left + p.x * viewScale;
          top = origin.top + p.y * viewScale;
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
      // Discard a ghost that was reparented to the body (renderBoard rebuilds
      // only the board's own subtree, so it wouldn't be swept up otherwise).
      if (box.parentElement === document.body) box.remove();
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
    const t = ctx(cand.id);
    // Landing position: the same origin, grid snap, and edge-contact
    // resolution the mid-drag ghost used, so the cell lands exactly where
    // the drag showed it.
    const originRect = dropOriginRect(cand.id);
    const moved = detach(draggedId);
    if (originRect) {
      const p = resolveCellPlacement(
        t.cell, moved,
        (clientX - grabDX - originRect.left) / viewScale,
        (clientY - grabDY - originRect.top) / viewScale,
      );
      moved.x = p.x;
      moved.y = p.y;
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

// ---- board-level events --------------------------------------------------------------

// A left-click that isn't on a card (a card stops its own pointerdown from
// bubbling) clears the selection.
boardEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".cell-box")) return;
  closeMenu();
  if (editing) commitEdit();
  selectedId = null;
  renderSelection();
});

// A right-click on a card is handled (and stopped) by that card's flip
// listener, so this only fires for the paper / bare board.
boardEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openPaperMenu(e.clientX, e.clientY);
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
  // when flipped, the value when it's a leaf front. A non-leaf front shows
  // children — nothing of its own to type into.
  const field = !c || c.cell === paperRoot() ? null
    : c.cell.flipped ? "name"
    : c.cell.children.length === 0 ? "value"
    : null;
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
    if (c && c.cell !== paperRoot()) c.cell.value = canonicalize(formulaInput.value);
    renderBoard();
    focusBoard();
  } else if (e.key === "Escape") {
    renderSelection();
    focusBoard();
  }
});

// ---- math view toggle ----------------------------------------------------------

const latexToggleEl = document.getElementById("latex-toggle");
latexToggleEl.checked = latexView;
latexToggleEl.addEventListener("change", () => {
  latexView = latexToggleEl.checked;
  try { localStorage.setItem(LATEX_VIEW_STORAGE_KEY, latexView ? "1" : "0"); } catch { /* preference only */ }
  if (editing) commitEdit();
  renderBoard();
});

// ---- paper size & orientation ---------------------------------------------------

for (const size of PAPER_ORDER) {
  const opt = el("option", null, size);
  opt.value = size;
  paperSelect.append(opt);
}

function syncPaperControls() {
  paperSelect.value = activeSheet().paper;
  orientBtn.textContent = activeSheet().orientation === "portrait" ? "縦" : "横";
  orientBtn.title = activeSheet().orientation === "portrait" ? "縦向き（クリックで横）" : "横向き（クリックで縦）";
}

paperSelect.addEventListener("change", () => {
  if (editing) commitEdit();
  activeSheet().paper = paperSelect.value;
  renderBoard();
});

orientBtn.addEventListener("click", () => {
  if (editing) commitEdit();
  activeSheet().orientation = activeSheet().orientation === "portrait" ? "landscape" : "portrait";
  syncPaperControls();
  renderBoard();
});

// ---- paper context menu (add a 親) --------------------------------------------------

let ctxMenu = null;

function closeMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

function openPaperMenu(clientX, clientY) {
  closeMenu();
  const menu = el("div", "ctx-menu");
  const item = el("button", "ctx-item", "親セルを追加");
  item.addEventListener("click", () => { addChild(paperRoot().id); closeMenu(); focusBoard(); });
  menu.append(item);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); focusBoard(); }
  });
  document.body.append(menu);
  ctxMenu = menu;
  menu.style.left = `${Math.max(8, Math.min(clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, innerHeight - menu.offsetHeight - 8))}px`;
}

// ---- sheet tabs -----------------------------------------------------------------
//
// The sheet name is its namespace (unique across the document). Click a tab to
// switch, double-click to rename, ＋ to add. Cross-sheet value references
// (`=SheetName!cellName`) build on this in the next slice.

/** Lowest free `SheetN` across the document. */
function autoSheetName() {
  const used = new Set(doc.sheets.map((s) => s.name.toLowerCase()));
  let n = 1;
  while (used.has(`sheet${n}`)) n++;
  return `Sheet${n}`;
}

/** Rename a sheet. Returns false (leaving the name unchanged) if empty, or a
 *  case-insensitive collision — sheet names are document-unique namespaces. */
function renameSheet(sheet, name) {
  name = name.trim();
  if (name === sheet.name) return true;
  if (name === "") return false;
  if (doc.sheets.some((s) => s !== sheet && s.name.toLowerCase() === name.toLowerCase())) return false;
  sheet.name = name;
  return true;
}

function renderTabs() {
  tabsEl.replaceChildren();
  doc.sheets.forEach((s, i) => {
    const tab = el("button", "sheet-tab", s.name);
    tab.setAttribute("aria-selected", String(i === doc.active));
    tab.addEventListener("click", () => switchSheet(i));
    tab.addEventListener("dblclick", (e) => { e.preventDefault(); beginRenameTab(s, tab); });
    tabsEl.append(tab);
  });
  const add = el("button", "sheet-tab add", "＋");
  add.title = "シートを追加";
  add.addEventListener("click", addSheet);
  tabsEl.append(add);
}

function beginRenameTab(sheet, tab) {
  let done = false;
  tab.contentEditable = "plaintext-only";
  tab.classList.add("editing");
  tab.focus();
  const range = document.createRange();
  range.selectNodeContents(tab);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    if (done) return;
    done = true;
    tab.contentEditable = "false";
    tab.classList.remove("editing");
    if (commit) renameSheet(sheet, tab.textContent.replace(/\n/g, ""));
    renderTabs();
    focusBoard();
  };
  tab.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  tab.addEventListener("blur", () => finish(true), { once: true });
}

function switchSheet(i) {
  if (i === doc.active) return;
  if (editing) commitEdit();
  doc.active = i;
  selectedId = null;
  renderTabs();
  syncPaperControls();
  renderBoard();
}

function addSheet() {
  if (editing) commitEdit();
  doc.sheets.push(makeSheet(autoSheetName()));
  switchSheet(doc.sheets.length - 1);
}

// ---- version badge (Ajisai's timestamp scheme) ---------------------------------------
//
// `ver.YYYYMMDDHHMM` — the build/release timestamp stamped into version.js at
// deploy, falling back to the current time when served build-free from source
// (mirrors Ajisai's setBuildVersionLabel / formatTimestamp).

function formatTimestamp(date) {
  const p = (n) => `${n}`.padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}`;
}

function setVersionLabel() {
  const elx = document.getElementById("version");
  if (elx) elx.textContent = `ver.${BUILD_TIMESTAMP || formatTimestamp(new Date())}`;
}

// ---- boot ------------------------------------------------------------------------------

setVersionLabel();
renderTabs();
syncPaperControls();
renderBoard();
focusBoard();

// Recompute the fit-to-width scale when the viewport changes (resize, rotate).
// Re-rendering is cheapest and keeps positions consistent; skip mid-edit.
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!editing) renderBoard(); }, 100);
});
