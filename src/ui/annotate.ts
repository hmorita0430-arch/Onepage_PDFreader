import {
  COLORS,
  COLOR_KEYS,
  STROKE_WIDTHS,
  addMemo,
  addRect,
  addStroke,
  centerOf,
  deleteAnnotation,
  hitHighlight,
  pointToNorm,
  rectFrom,
  restoreAnnotation,
  sideAt,
  simplifyPoints,
  smoothPath,
  updateMemoText,
  visibleAnnotations,
  type StrokeThickness,
} from '../model/annotations';
import type { ViewSpec } from '../model/layout';
import type { Annotation, AnnotationColor, BookSyncDocument, NormPoint, PageRef } from '../model/types';
import { layout, type Size, type ViewState } from '../reader/view';

/**
 * 注釈(蛍光ペン・位置つきメモ)の画面: ツールバー、ページ上への描画、メモの入力、右クリックメニュー、
 * 元に戻す/やり直す。座標は元画像基準の正規化座標で持つ(4章)。ズーム・移動・分割・トリミングが変わっても動かない。
 */
export interface Geom {
  spec: ViewSpec;
  /** フィット表示したときのCSSサイズ */
  fit: Size;
  /** PDFページ(見開き1枚)全体の大きさ */
  page: Size;
  /** 表示領域の大きさ */
  box: Size;
  view: ViewState;
}

export interface AnnotateDeps {
  getDoc(): BookSyncDocument | null;
  getGeom(): Geom | null;
  prev(): void;
  next(): void;
  /** 注釈を書き換えた。保存と同期の予約は呼ぶ側で行う */
  commit(): void;
  /** ツールバーの表示・非表示(表示領域の大きさが変わるので、呼ぶ側で再描画する) */
  onModeChange(active: boolean): void;
}

type Tool = 'rect' | 'stroke' | 'memo' | 'erase';
type DrawTool = 'rect' | 'stroke';

const NS = 'http://www.w3.org/2000/svg';
const TOOL_KEY = 'ann-tool:v1';
const COLOR_STORE = 'ann-color:v1';
const WIDTH_STORE = 'ann-width:v1';
const HISTORY_LIMIT = 50;
/** 点の間引きの許容(画面上のピクセル)。小さいほど元の線に忠実、大きいほどデータが小さい */
const SIMPLIFY_PX = 1.5;
/** これより近い点は取り込まない(画面上のピクセル) */
const MIN_POINT_GAP_PX = 1.5;

const HINTS: Record<Tool, string> = {
  rect: 'ドラッグで四角く囲みます。',
  stroke: 'なぞって線を引きます。',
  memo: 'メモを置く場所をタップします。',
  erase: '消したい蛍光ペンをタップします。',
};
const COMMON_HINT = ' 拡大は2本指(ホイール)、Shift+ドラッグで移動。元に戻す: Ctrl+Z';

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} がありません`);
  return e as T;
};
const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 保存できなくても、この回は反映される */
  }
};

interface HistoryOp {
  undo(): void;
  redo(): void;
}

type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; css: string }
  | { kind: 'stroke'; d: string; width: number; css: string };

export function createAnnotator(deps: AnnotateDeps, pageEl: HTMLElement) {
  const bar = el('ann-bar');
  const hint = el('ann-hint');
  const editor = el('memo-editor');
  const memoText = el<HTMLTextAreaElement>('memo-text');
  const memoDelete = el<HTMLButtonElement>('memo-delete');
  const menu = el('ctx-menu');
  const oneShotHint = el('oneshot-hint');
  const undoBtn = el<HTMLButtonElement>('ann-undo');
  const redoBtn = el<HTMLButtonElement>('ann-redo');
  const widthsEl = el('ann-widths');
  const toolButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  const colorButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-color]')];
  const widthButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-width]')];
  const menuColorButtons = [...menu.querySelectorAll<HTMLButtonElement>('[data-ctx-color]')];

  let active = false;
  /** 右クリックメニューから選んだ「1回だけ描く」ツール。描き終えたら閲覧に戻る */
  let oneShot: DrawTool | null = null;
  let tool: Tool = (['rect', 'stroke', 'memo', 'erase'] as const).find((t) => t === read(TOOL_KEY)) ?? 'rect';
  let color: AnnotationColor = COLOR_KEYS.find((c) => c === read(COLOR_STORE)) ?? 'yellow';
  let thickness: StrokeThickness = (['thin', 'medium', 'thick'] as const).find((t) => t === read(WIDTH_STORE)) ?? 'medium';
  const curTool = (): Tool => oneShot ?? tool;

  // ---- 元に戻す/やり直す ----
  // 注釈の書き換えは、削除の印(墓標)の付け外しで表すので、同期で他の端末の変更を巻き戻さない。
  const undoStack: HistoryOp[] = [];
  const redoStack: HistoryOp[] = [];

  function apply(fn: (list: readonly Annotation[]) => Annotation[]): void {
    const doc = deps.getDoc();
    if (!doc) return;
    doc.annotations = fn(doc.annotations);
    deps.commit();
    render();
  }

  function record(op: HistoryOp): void {
    undoStack.push(op);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    renderBar();
  }

  /** 作成を記録する: 元に戻す=削除の印、やり直す=印を外す */
  function recordCreate(id: string): void {
    record({
      undo: () => apply((l) => deleteAnnotation(l, id)),
      redo: () => apply((l) => restoreAnnotation(l, id)),
    });
  }

  function undo(): void {
    const op = undoStack.pop();
    if (!op) return;
    op.undo();
    redoStack.push(op);
    renderBar();
  }

  function redo(): void {
    const op = redoStack.pop();
    if (!op) return;
    op.redo();
    undoStack.push(op);
    renderBar();
  }

  // ---- ページ上の描画層 ----
  const layer = document.createElement('div');
  layer.className = 'ann-layer';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const pins = document.createElement('div');
  pins.className = 'pins';
  layer.append(svg, pins);
  pageEl.append(layer);

  function shapeEl(s: Shape): SVGElement {
    if (s.kind === 'rect') {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(s.x));
      r.setAttribute('y', String(s.y));
      r.setAttribute('width', String(s.w));
      r.setAttribute('height', String(s.h));
      r.setAttribute('fill', s.css);
      r.setAttribute('class', 'hl');
      return r;
    }
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', s.d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', s.css);
    p.setAttribute('stroke-width', String(s.width));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('class', 'hl');
    return p;
  }

  let preview: SVGElement | null = null;

  /** 保存済みの注釈を描き直す(ページを変えた・ズームした・同期で増えた、などのとき) */
  function render(): void {
    const doc = deps.getDoc();
    const g = deps.getGeom();
    svg.replaceChildren();
    pins.replaceChildren();
    preview = null;
    if (!doc || !g) return;
    const { region, pdfPage } = g.spec;
    const W = g.page.w;
    const H = g.page.h;
    svg.setAttribute('viewBox', `${region.x * W} ${region.y * H} ${region.w * W} ${region.h * H}`);

    for (const a of visibleAnnotations(doc.annotations)) {
      if (a.page.pdfPage !== pdfPage) continue;
      if (a.kind === 'highlight-rect') {
        svg.append(shapeEl({ kind: 'rect', x: a.rect.x * W, y: a.rect.y * H, w: a.rect.w * W, h: a.rect.h * H, css: COLORS[a.color].css }));
      } else if (a.kind === 'highlight-stroke') {
        svg.append(shapeEl({ kind: 'stroke', d: smoothPath(a.points.map((p) => ({ x: p.x * W, y: p.y * H }))), width: a.width * W, css: COLORS[a.color].css }));
      } else {
        // 表示範囲の中にあるメモだけ、ピンを出す
        if (a.at.x < region.x || a.at.x > region.x + region.w || a.at.y < region.y || a.at.y > region.y + region.h) continue;
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'memo-pin';
        pin.textContent = '✎';
        pin.setAttribute('aria-label', `メモを開く: ${a.text.slice(0, 20)}`);
        pin.style.left = `${((a.at.x - region.x) / region.w) * 100}%`;
        pin.style.top = `${((a.at.y - region.y) / region.h) * 100}%`;
        // ピンの操作が、ページ送りやメニューの操作として扱われないようにする
        pin.addEventListener('pointerdown', (e) => e.stopPropagation());
        pin.addEventListener('pointerup', (e) => e.stopPropagation());
        pin.addEventListener('contextmenu', (e) => e.stopPropagation());
        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditor({ id: a.id, text: a.text });
        });
        pins.append(pin);
      }
    }
  }

  /** ピンの大きさを、ズームしても変えない */
  function setZoom(z: number): void {
    layer.style.setProperty('--zoom', String(z));
  }

  // ---- 描画(ドラッグ) ----
  let drag: {
    start: NormPoint;
    sx: number;
    sy: number;
    points: NormPoint[];
    last: { x: number; y: number };
    moved: number;
  } | null = null;

  function toNorm(x: number, y: number): { p: NormPoint; g: Geom } | null {
    const g = deps.getGeom();
    if (!g) return null;
    const l = layout(g.box, g.fit, g.view);
    return { p: pointToNorm(x, y, l, g.fit, g.spec.region), g };
  }

  const pageRef = (p: NormPoint, g: Geom, doc: BookSyncDocument): PageRef => ({
    pdfPage: g.spec.pdfPage,
    side: sideAt(p.x, g.spec.pdfPage, doc.settings),
  });

  /** 画面上の1pxが、元のPDFの単位でいくつか */
  const unitsPerPx = (g: Geom): number => (g.spec.region.w * g.page.w) / (g.fit.w * g.view.z);

  function onDrawStart(x: number, y: number): void {
    const n = toNorm(x, y);
    if (!n || (!active && !oneShot)) return;
    drag = { start: n.p, sx: x, sy: y, points: [n.p], last: { x, y }, moved: 0 };
  }

  function onDrawMove(x: number, y: number): void {
    if (!drag) return;
    const n = toNorm(x, y);
    if (!n) return;
    drag.moved = Math.max(drag.moved, Math.hypot(x - drag.sx, y - drag.sy));
    const { g } = n;
    const W = g.page.w;
    const H = g.page.h;
    const css = COLORS[color].css;
    const t = curTool();
    if (t === 'rect') {
      const r = rectFrom(drag.start, n.p);
      preview?.remove();
      preview = shapeEl({ kind: 'rect', x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H, css });
      preview.setAttribute('class', 'hl preview');
      svg.append(preview);
    } else if (t === 'stroke') {
      if (Math.hypot(x - drag.last.x, y - drag.last.y) < MIN_POINT_GAP_PX) return; // 細かすぎる点は取り込まない
      drag.last = { x, y };
      drag.points.push(n.p);
      preview?.remove();
      // 描いている途中から、仕上がりと同じ滑らかな線で見せる
      preview = shapeEl({ kind: 'stroke', d: smoothPath(drag.points.map((p) => ({ x: p.x * W, y: p.y * H }))), width: STROKE_WIDTHS[thickness] * W, css });
      preview.setAttribute('class', 'hl preview');
      svg.append(preview);
    }
  }

  function finishOneShot(): void {
    if (!oneShot) return;
    oneShot = null;
    oneShotHint.hidden = true;
    renderBar();
  }

  function onDrawEnd(x: number, y: number, cancelled: boolean): void {
    const d = drag;
    drag = null;
    preview?.remove();
    preview = null;
    const doc = deps.getDoc();
    const n = toNorm(x, y);
    if (!d || cancelled || !doc || !n) return; // 2本目の指が触れた等で中止。1回だけのモードは続ける
    const tap = d.moved < 10;
    const t = curTool();
    const { g } = n;

    // 四角は、縦横とも一定以上ドラッグしたときだけ作る(横にだけ動かして、高さ0の見えない蛍光ペンを作らない)
    if (t === 'rect' && Math.abs(x - d.sx) >= 6 && Math.abs(y - d.sy) >= 6) {
      const r = rectFrom(d.start, n.p);
      const next = addRect(doc.annotations, { page: pageRef(centerOf(r), g, doc), color, rect: r });
      doc.annotations = next;
      deps.commit();
      render();
      recordCreate(next[next.length - 1]!.id);
    } else if (t === 'stroke' && d.points.length >= 2) {
      // 手ぶれの細かい点を間引き、書き出し・同期のデータも小さくする
      const pts = simplifyPoints([...d.points, n.p], SIMPLIFY_PX * unitsPerPx(g), g.page);
      const mid = pts[Math.floor(pts.length / 2)]!;
      const next = addStroke(doc.annotations, { page: pageRef(mid, g, doc), color, points: pts, width: STROKE_WIDTHS[thickness] });
      doc.annotations = next;
      deps.commit();
      render();
      recordCreate(next[next.length - 1]!.id);
    } else if (t === 'memo' && tap) {
      openEditor({ at: n.p, page: pageRef(n.p, g, doc) });
    } else if (t === 'erase' && tap) {
      // 画面上の約10pxを、元のPDFの単位に直した余裕
      const tol = 10 * unitsPerPx(g);
      const hits = visibleAnnotations(doc.annotations).filter(
        (a) => a.page.pdfPage === g.spec.pdfPage && hitHighlight(a, n.p, tol, g.page),
      );
      const top = hits[hits.length - 1]; // 最後に作ったもの(いちばん上)
      if (top) {
        const id = top.id;
        apply((l) => deleteAnnotation(l, id));
        record({ undo: () => apply((l) => restoreAnnotation(l, id)), redo: () => apply((l) => deleteAnnotation(l, id)) });
      }
    }
    finishOneShot();
  }

  // ---- メモの入力 ----
  let editing: { id?: string; at?: NormPoint; page?: PageRef; prevText?: string } | null = null;

  function openEditor(e: { id?: string; text?: string; at?: NormPoint; page?: PageRef }): void {
    editing = { id: e.id, at: e.at, page: e.page, prevText: e.text };
    memoText.value = e.text ?? '';
    memoDelete.hidden = !e.id;
    editor.hidden = false;
    memoText.focus();
  }

  function closeEditor(): void {
    editing = null;
    editor.hidden = true;
  }

  function saveMemo(): void {
    const doc = deps.getDoc();
    const e = editing;
    const text = memoText.value.trim();
    if (!doc || !e || text === '') return closeEditor(); // 空のメモは作らない/変えない
    if (e.id) {
      const id = e.id;
      const prev = e.prevText ?? '';
      if (text !== prev) {
        apply((l) => updateMemoText(l, id, text));
        record({ undo: () => apply((l) => updateMemoText(l, id, prev)), redo: () => apply((l) => updateMemoText(l, id, text)) });
      }
    } else if (e.at && e.page) {
      const next = addMemo(doc.annotations, { page: e.page, at: e.at, text });
      doc.annotations = next;
      deps.commit();
      render();
      recordCreate(next[next.length - 1]!.id);
    }
    closeEditor();
  }

  function deleteMemo(): void {
    const id = editing?.id;
    if (!deps.getDoc() || !id) return;
    if (!confirm('このメモを削除しますか?')) return;
    apply((l) => deleteAnnotation(l, id));
    record({ undo: () => apply((l) => restoreAnnotation(l, id)), redo: () => apply((l) => deleteAnnotation(l, id)) });
    closeEditor();
  }

  el('memo-save').addEventListener('click', saveMemo);
  memoDelete.addEventListener('click', deleteMemo);
  el('memo-cancel').addEventListener('click', closeEditor);
  memoText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveMemo();
    if (e.key === 'Escape') {
      e.stopPropagation(); // メモ入力欄を閉じるだけにする(その下の画面は閉じない)
      closeEditor();
    }
  });

  /** 一覧画面などから、既存のメモを開く */
  function editMemo(id: string): void {
    const a = deps.getDoc()?.annotations.find((x) => x.id === id);
    if (a && a.kind === 'memo' && !a.deleted) openEditor({ id, text: a.text });
  }

  /** 読書中の長押し(タッチ)で、その場にメモを置く */
  function placeMemoAt(x: number, y: number): void {
    const doc = deps.getDoc();
    const n = toNorm(x, y);
    if (!doc || !n) return;
    openEditor({ at: n.p, page: pageRef(n.p, n.g, doc) });
  }

  // ---- 右クリックメニュー(読書中に、注釈モードに入らず付ける) ----
  let menuPoint = { x: 0, y: 0 };
  const onOutside = (e: Event) => {
    if (menu.contains(e.target as Node)) return;
    closeMenu();
    // メニューを閉じるためのクリックは、ページ送りやメニュー表示としては扱わない
    e.stopPropagation();
  };

  function openContextMenu(x: number, y: number): void {
    menuPoint = { x, y };
    menu.hidden = false;
    const parent = menu.offsetParent as HTMLElement | null;
    const maxX = (parent?.clientWidth ?? window.innerWidth) - menu.offsetWidth - 8;
    const maxY = (parent?.clientHeight ?? window.innerHeight) - menu.offsetHeight - 8;
    menu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
    renderMenuColors();
    document.addEventListener('pointerdown', onOutside, true);
    menu.querySelector<HTMLButtonElement>('[data-ctx]')?.focus();
  }

  function closeMenu(): void {
    menu.hidden = true;
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function renderMenuColors(): void {
    for (const b of menuColorButtons) b.setAttribute('aria-pressed', String(b.dataset.ctxColor === color));
  }

  function beginOneShot(t: DrawTool): void {
    closeMenu();
    oneShot = t;
    oneShotHint.textContent = (t === 'rect' ? 'ドラッグで四角く囲みます' : 'なぞって線を引きます') + '(Escで中止)';
    oneShotHint.hidden = false;
  }

  function cancelOneShot(): void {
    drag = null;
    preview?.remove();
    preview = null;
    finishOneShot();
  }

  for (const b of menu.querySelectorAll<HTMLButtonElement>('[data-ctx]')) {
    b.addEventListener('click', () => {
      const act = b.dataset.ctx;
      if (act === 'memo') {
        closeMenu();
        placeMemoAt(menuPoint.x, menuPoint.y);
      } else if (act === 'rect' || act === 'stroke') {
        beginOneShot(act);
      }
    });
  }
  for (const b of menuColorButtons) {
    b.style.setProperty('--swatch', COLORS[b.dataset.ctxColor as AnnotationColor].css);
    b.addEventListener('click', () => {
      color = b.dataset.ctxColor as AnnotationColor;
      write(COLOR_STORE, color);
      renderMenuColors();
      renderBar();
    });
  }

  // ---- ツールバー ----
  function renderBar(): void {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    for (const b of colorButtons) b.setAttribute('aria-pressed', String(b.dataset.color === color));
    for (const b of widthButtons) b.setAttribute('aria-pressed', String(b.dataset.width === thickness));
    widthsEl.hidden = tool !== 'stroke';
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    hint.textContent = HINTS[tool] + COMMON_HINT;
  }
  for (const b of toolButtons) {
    b.addEventListener('click', () => {
      tool = b.dataset.tool as Tool;
      write(TOOL_KEY, tool);
      renderBar();
    });
  }
  for (const b of colorButtons) {
    b.style.setProperty('--swatch', COLORS[b.dataset.color as AnnotationColor].css);
    b.addEventListener('click', () => {
      color = b.dataset.color as AnnotationColor;
      write(COLOR_STORE, color);
      renderBar();
    });
  }
  for (const b of widthButtons) {
    b.addEventListener('click', () => {
      thickness = b.dataset.width as StrokeThickness;
      write(WIDTH_STORE, thickness);
      renderBar();
    });
  }
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  el('ann-prev').addEventListener('click', deps.prev);
  el('ann-next').addEventListener('click', deps.next);
  el('ann-done').addEventListener('click', () => exit());

  function enter(): void {
    if (active) return;
    cancelOneShot();
    active = true;
    bar.hidden = false;
    renderBar();
    deps.onModeChange(true);
  }

  function exit(): void {
    if (!active) return;
    active = false;
    drag = null;
    preview?.remove();
    preview = null;
    closeEditor();
    closeMenu();
    bar.hidden = true;
    deps.onModeChange(false);
  }

  /** 本を閉じたとき */
  function reset(): void {
    active = false;
    drag = null;
    closeEditor();
    closeMenu();
    finishOneShot();
    undoStack.length = 0;
    redoStack.length = 0;
    bar.hidden = true;
    svg.replaceChildren();
    pins.replaceChildren();
  }

  return {
    enter,
    exit,
    reset,
    render,
    setZoom,
    undo,
    redo,
    placeMemoAt,
    openContextMenu,
    closeMenu,
    cancelOneShot,
    editMemo,
    isActive: () => active,
    isEditorOpen: () => !editor.hidden,
    isMenuOpen: () => !menu.hidden,
    isOneShot: () => oneShot !== null,
    closeEditor,
    /** ジェスチャーに渡す、描画の操作 */
    draw: { drawActive: () => active || oneShot !== null, onDrawStart, onDrawMove, onDrawEnd },
  };
}
