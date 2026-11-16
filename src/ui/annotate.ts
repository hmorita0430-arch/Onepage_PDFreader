import {
  COLORS,
  COLOR_KEYS,
  STROKE_WIDTHS,
  addMemo,
  addRect,
  addStroke,
  centerOf,
  deleteAnnotation,
  geometryOf,
  hitHighlight,
  movedGeometry,
  pointToNorm,
  rectFrom,
  resizedRect,
  restoreAnnotation,
  setAnnotationColor,
  setAnnotationGeometry,
  sideAt,
  simplifyPoints,
  smoothPath,
  stretchedStroke,
  updateMemoText,
  visibleAnnotations,
  type Geometry,
  type RectCorner,
  type StrokeEnd,
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
  /** タッチ(指)で描くときの位置の補正(画面のピクセル)。なければ、補正なし */
  touchOffset?(): { x: number; y: number };
  /** 削除したことを知らせ、「元に戻す」を出す(誤って消したときのため) */
  onDeleted?(message: string, undo: () => void): void;
}

type Tool = 'rect' | 'stroke' | 'memo' | 'erase' | 'select';
type DrawTool = 'rect' | 'stroke';

const NS = 'http://www.w3.org/2000/svg';
const TOOL_KEY = 'ann-tool:v1';
const COLOR_STORE = 'ann-color:v1';
const WIDTH_STORE = 'ann-width:v1';
const HISTORY_LIMIT = 50;
/** 長押しから蛍光ペンを選んだあと、この時間(ミリ秒)何も描かないと、通常の読書に戻る */
export const QUICK_IDLE_MS = 8000;
/** 点の間引きの許容(画面上のピクセル)。小さいほど元の線に忠実、大きいほどデータが小さい */
const SIMPLIFY_PX = 1.5;
/** これより近い点は取り込まない(画面上のピクセル) */
const MIN_POINT_GAP_PX = 1.5;

const HINTS: Record<Tool, string> = {
  rect: 'ドラッグで四角く囲みます。',
  stroke: 'なぞって線を引きます。',
  memo: 'メモを置く場所をタップします。',
  erase: '消したい蛍光ペンをタップします。',
  select: '蛍光ペンをタップして選びます。●をドラッグして伸ばす・縮める、✥で動かします。',
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
  const quickBar = el('oneshot-hint');
  const quickText = el('oneshot-text');
  const quickUndo = el<HTMLButtonElement>('quick-undo');
  const quickColorButtons = [...quickBar.querySelectorAll<HTMLButtonElement>('[data-quick-color]')];
  const quickToolButtons = [...quickBar.querySelectorAll<HTMLButtonElement>('[data-quick-tool]')];
  const quickDelete = el<HTMLButtonElement>('quick-delete');
  const selBar = el('sel-bar');
  const selUndo = el<HTMLButtonElement>('sel-undo');
  const selColorButtons = [...selBar.querySelectorAll<HTMLButtonElement>('[data-sel-color]')];
  const ctxTarget = el('ctx-target');
  const ctxTargetColorButtons = [...ctxTarget.querySelectorAll<HTMLButtonElement>('[data-ctx-tcolor]')];
  const undoBtn = el<HTMLButtonElement>('ann-undo');
  const redoBtn = el<HTMLButtonElement>('ann-redo');
  const widthsEl = el('ann-widths');
  const toolButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  const colorButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-color]')];
  const widthButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-width]')];
  const menuColorButtons = [...menu.querySelectorAll<HTMLButtonElement>('[data-ctx-color]')];

  let active = false;
  /**
   * 長押し・右クリックのメニューから選んだ蛍光ペンのツール。続けて何本でも引ける。
   * 「完了」・戻る・Esc、または一定時間(QUICK_IDLE_MS)何も描かないと、通常の読書に戻る。
   */
  let oneShot: DrawTool | null = null;
  let quickTimer: ReturnType<typeof setTimeout> | undefined;
  /** 長押しから入った「蛍光ペンを選んで直す」状態(注釈モードに入らない) */
  let selecting = false;
  /** 選んでいる蛍光ペン(注釈のID) */
  let selectedId: string | null = null;
  let tool: Tool = (['rect', 'stroke', 'memo', 'erase', 'select'] as const).find((t) => t === read(TOOL_KEY)) ?? 'rect';
  let color: AnnotationColor = COLOR_KEYS.find((c) => c === read(COLOR_STORE)) ?? 'yellow';
  let thickness: StrokeThickness = (['thin', 'medium', 'thick'] as const).find((t) => t === read(WIDTH_STORE)) ?? 'medium';
  const curTool = (): Tool => oneShot ?? (selecting ? 'select' : tool);

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
  /** 取っ手をドラッグしている間の、仮の形(離したときに保存する) */
  let live: { id: string; geom: Geometry } | null = null;
  const handleEls = new Map<string, HTMLButtonElement>();
  let handleGeom: Geom | null = null;

  const findSelected = (doc: BookSyncDocument): Exclude<Annotation, { kind: 'memo' }> | null => {
    const a = selectedId ? visibleAnnotations(doc.annotations).find((x) => x.id === selectedId) : undefined;
    return a && a.kind !== 'memo' ? a : null;
  };

  /** 蛍光ペン(四角・線)を描く。取っ手をドラッグしている間は、仮の形で描く */
  function drawShapes(doc: BookSyncDocument, g: Geom): void {
    svg.replaceChildren();
    preview = null;
    const { region, pdfPage } = g.spec;
    const W = g.page.w;
    const H = g.page.h;
    svg.setAttribute('viewBox', `${region.x * W} ${region.y * H} ${region.w * W} ${region.h * H}`);
    for (const a of visibleAnnotations(doc.annotations)) {
      if (a.page.pdfPage !== pdfPage || a.kind === 'memo') continue;
      const lv = live && live.id === a.id ? live.geom : null;
      if (a.kind === 'highlight-rect') {
        const r = lv && 'rect' in lv ? lv.rect : a.rect;
        svg.append(shapeEl({ kind: 'rect', x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H, css: COLORS[a.color].css }));
        if (a.id === selectedId) {
          const o = document.createElementNS(NS, 'rect');
          for (const [k, v] of [['x', r.x * W], ['y', r.y * H], ['width', r.w * W], ['height', r.h * H]] as const) o.setAttribute(k, String(v));
          o.setAttribute('class', 'sel-outline');
          svg.append(o);
        }
      } else {
        const pts = lv && 'points' in lv ? lv.points : a.points;
        const d = smoothPath(pts.map((p) => ({ x: p.x * W, y: p.y * H })));
        svg.append(shapeEl({ kind: 'stroke', d, width: a.width * W, css: COLORS[a.color].css }));
        if (a.id === selectedId) {
          const o = document.createElementNS(NS, 'path');
          o.setAttribute('d', d);
          o.setAttribute('stroke-width', String(a.width * W + 6));
          o.setAttribute('class', 'sel-outline');
          o.setAttribute('stroke-linecap', 'round');
          svg.append(o);
        }
      }
    }
  }

  /** 保存済みの注釈を描き直す(ページを変えた・ズームした・同期で増えた、などのとき) */
  function render(): void {
    const doc = deps.getDoc();
    const g = deps.getGeom();
    svg.replaceChildren();
    pins.replaceChildren();
    handleEls.clear();
    preview = null;
    if (!doc || !g) return;
    // 選んでいる蛍光ペンが、このページに無い(ページを変えた・消えた)ときは、選択を外す
    if (selectedId && !live) {
      const sel = findSelected(doc);
      if (!sel || sel.page.pdfPage !== g.spec.pdfPage) endSelection(false);
    }
    drawShapes(doc, g);
    const { region } = g.spec;
    for (const a of visibleAnnotations(doc.annotations)) {
      if (a.page.pdfPage !== g.spec.pdfPage || a.kind !== 'memo') continue;
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
    buildHandles(doc, g);
    syncSelUi();
  }

  // ---- 選んだ蛍光ペンの取っ手(動かす・伸ばす・縮める) ----

  function handlePoints(a: Exclude<Annotation, { kind: 'memo' }>, geom: Geometry): Array<{ h: string; x: number; y: number }> {
    if (a.kind === 'highlight-rect' && 'rect' in geom) {
      const r = geom.rect;
      return [
        { h: 'nw', x: r.x, y: r.y },
        { h: 'ne', x: r.x + r.w, y: r.y },
        { h: 'sw', x: r.x, y: r.y + r.h },
        { h: 'se', x: r.x + r.w, y: r.y + r.h },
        { h: 'move', x: r.x + r.w / 2, y: r.y + r.h / 2 },
      ];
    }
    if (a.kind === 'highlight-stroke' && 'points' in geom && geom.points.length > 0) {
      const p = geom.points;
      // 動かす取っ手は、線の道のりの真ん中に置く(点が2つだけの線でも、端の取っ手と重ならない)
      const mid = pointAtHalf(p, handleGeomPage());
      return [
        { h: 'start', x: p[0]!.x, y: p[0]!.y },
        { h: 'end', x: p[p.length - 1]!.x, y: p[p.length - 1]!.y },
        { h: 'move', x: mid.x, y: mid.y },
      ];
    }
    return [];
  }

  const handleGeomPage = (): { w: number; h: number } => handleGeom?.page ?? deps.getGeom()?.page ?? { w: 1, h: 1 };

  /** 折れ線の、道のりの半分の位置の点(縦横比を考えたピクセルで測る) */
  function pointAtHalf(pts: readonly NormPoint[], page: { w: number; h: number }): NormPoint {
    if (pts.length === 1) return pts[0]!;
    const seg: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot((pts[i]!.x - pts[i - 1]!.x) * page.w, (pts[i]!.y - pts[i - 1]!.y) * page.h);
      seg.push(d);
      total += d;
    }
    if (total === 0) return pts[0]!;
    let rest = total / 2;
    for (let i = 0; i < seg.length; i++) {
      if (rest <= seg[i]!) {
        const t = seg[i] === 0 ? 0 : rest / seg[i]!;
        return { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * t, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * t };
      }
      rest -= seg[i]!;
    }
    return pts[pts.length - 1]!;
  }

  function placeHandles(a: Exclude<Annotation, { kind: 'memo' }>): void {
    const g = handleGeom;
    if (!g) return;
    const geom = live && live.id === a.id ? live.geom : geometryOf(a);
    if (!geom) return;
    const { region } = g.spec;
    for (const p of handlePoints(a, geom)) {
      const b = handleEls.get(p.h);
      if (!b) continue;
      b.style.left = `${((p.x - region.x) / region.w) * 100}%`;
      b.style.top = `${((p.y - region.y) / region.h) * 100}%`;
    }
  }

  function buildHandles(doc: BookSyncDocument, g: Geom): void {
    handleEls.clear();
    handleGeom = g;
    const a = findSelected(doc);
    if (!a || a.page.pdfPage !== g.spec.pdfPage) return;
    const geom = geometryOf(a);
    if (!geom) return;
    for (const p of handlePoints(a, geom)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sel-handle';
      b.dataset.h = p.h;
      if (p.h === 'move' && a.kind === 'highlight-stroke') b.classList.add('above'); // 線の上に、少し浮かせる(文字と端の取っ手を隠さない)
      b.textContent = p.h === 'move' ? '✥' : '';
      b.setAttribute('aria-label', p.h === 'move' ? '蛍光ペンを動かす' : '蛍光ペンの端を動かして伸ばす・縮める');
      attachHandle(b, p.h);
      handleEls.set(p.h, b);
      pins.append(b);
    }
    placeHandles(a);
  }

  let handleDrag: {
    name: string;
    pointerId: number;
    id: string;
    before: Geometry;
    /** つかんだ点の、元の位置(正規化)。動かす量だけを足して、新しい位置にする */
    orig: NormPoint;
    startClient: { x: number; y: number };
    changed: boolean;
  } | null = null;

  /** 画面上の動き(クライアント座標)を、元画像基準の正規化座標の動きに直す */
  function deltaNorm(from: { x: number; y: number }, to: { x: number; y: number }): NormPoint | null {
    const stage = (pageEl.offsetParent ?? pageEl.parentElement) as HTMLElement | null;
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    const a = toNorm(from.x - r.left, from.y - r.top);
    const b = toNorm(to.x - r.left, to.y - r.top);
    if (!a || !b) return null;
    return { x: b.p.x - a.p.x, y: b.p.y - a.p.y };
  }

  function attachHandle(btn: HTMLButtonElement, name: string): void {
    const stop = (e: Event) => e.stopPropagation(); // ページ送り・メニューの操作として扱わない
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const doc = deps.getDoc();
      const a = doc ? findSelected(doc) : null;
      const geom = a ? geometryOf(a) : null;
      if (!a || !geom) return;
      const orig = handlePoints(a, geom).find((p) => p.h === name);
      if (!orig) return;
      btn.setPointerCapture(e.pointerId);
      handleDrag = { name, pointerId: e.pointerId, id: a.id, before: geom, orig: { x: orig.x, y: orig.y }, startClient: { x: e.clientX, y: e.clientY }, changed: false };
    });
    btn.addEventListener('pointermove', (e) => {
      const d = handleDrag;
      const doc = deps.getDoc();
      const g = deps.getGeom();
      if (!d || d.pointerId !== e.pointerId || !doc || !g) return;
      e.stopPropagation();
      const delta = deltaNorm(d.startClient, { x: e.clientX, y: e.clientY });
      if (!delta) return;
      const a = visibleAnnotations(doc.annotations).find((x) => x.id === d.id);
      if (!a || a.kind === 'memo') return;
      let next: Geometry | null = null;
      const target = { x: d.orig.x + delta.x, y: d.orig.y + delta.y };
      if (d.name === 'move') {
        next = movedGeometry({ ...a, ...d.before } as Annotation, delta.x, delta.y);
      } else if (a.kind === 'highlight-rect' && 'rect' in d.before) {
        next = { rect: resizedRect(d.before.rect, d.name as RectCorner, target) };
      } else if (a.kind === 'highlight-stroke' && 'points' in d.before) {
        next = { points: stretchedStroke(d.before.points, d.name as StrokeEnd, target, g.page) };
      }
      if (!next) return;
      live = { id: d.id, geom: next };
      d.changed = true;
      drawShapes(doc, g);
      placeHandles(a);
    });
    const finish = (e: PointerEvent, cancelled: boolean) => {
      const d = handleDrag;
      if (!d || d.pointerId !== e.pointerId) return;
      e.stopPropagation();
      handleDrag = null;
      const l = live;
      live = null;
      const doc = deps.getDoc();
      if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      if (!doc) return;
      if (cancelled || !l || !d.changed) {
        render();
        return;
      }
      const before = d.before;
      const after = l.geom;
      const id = d.id;
      doc.annotations = setAnnotationGeometry(doc.annotations, id, after);
      deps.commit();
      render();
      record({
        undo: () => apply((list) => setAnnotationGeometry(list, id, before)),
        redo: () => apply((list) => setAnnotationGeometry(list, id, after)),
      });
    };
    btn.addEventListener('pointerup', (e) => finish(e, false));
    btn.addEventListener('pointercancel', (e) => finish(e, true));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', stop);
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
    if (!n || (!active && !oneShot && !selecting)) return;
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

  // ---- 続けて引く・選んで直す(長押し・右クリックのメニューから。同じバーで切り替える) ----
  const sessionOn = (): boolean => oneShot !== null || selecting;

  function armQuickIdle(): void {
    clearTimeout(quickTimer);
    quickTimer = setTimeout(() => {
      if (!oneShot) return; // 選んで直している間は、自動では戻さない
      if (drag) return armQuickIdle(); // 描いている最中は、戻さない
      endSession();
    }, QUICK_IDLE_MS);
  }

  /** 続けて引く・選ぶ、の状態を、すべて終える(通常の読書に戻る) */
  function endSession(): void {
    const was = sessionOn();
    oneShot = null;
    clearTimeout(quickTimer);
    endSelection();
    quickBar.hidden = true;
    if (was) renderBar();
  }

  function quickMessage(): string {
    if (selecting) {
      return selectedId
        ? '●をドラッグして伸ばす・縮める。✥で動かす。色も変えられます。「完了」か「戻る」で終わります'
        : '蛍光ペンをタップして選びます。選んだら、●で伸ばす・縮める、✥で動かせます。「完了」か「戻る」で終わります';
    }
    return (
      (oneShot === 'rect' ? 'ドラッグで四角く囲みます。' : 'なぞって線を引きます。') +
      `続けて引けます。${QUICK_IDLE_MS / 1000}秒引かないと、自動で戻ります。「完了」か「戻る」でも終わります`
    );
  }

  /** バーの表示(いまの操作・色・消すボタン・戻す)を、状態に合わせる */
  function syncQuickBar(): void {
    quickBar.hidden = !sessionOn();
    if (quickBar.hidden) return;
    quickText.textContent = quickMessage();
    for (const b of quickToolButtons) {
      const t = b.dataset.quickTool;
      b.setAttribute('aria-pressed', String(t === 'select' ? selecting : t === oneShot));
    }
    // 蛍光ペンを選んでいる間は、色は、その蛍光ペンの色。それ以外は、新しく引く色
    const doc = deps.getDoc();
    const sel = selecting && doc ? findSelected(doc) : null;
    for (const b of quickColorButtons) b.setAttribute('aria-pressed', String(b.dataset.quickColor === (sel ? sel.color : color)));
    quickDelete.hidden = !sel;
    quickUndo.disabled = undoStack.length === 0;
  }

  function renderQuickColors(): void {
    syncQuickBar();
  }

  // ---- 蛍光ペンを選ぶ(動かす・伸ばす・縮める・消す・色を変える) ----
  const SEL_TEXT = '●をドラッグして伸ばす・縮める。✥で動かす。「戻る」でも終わります';

  function syncSelUi(): void {
    const doc = deps.getDoc();
    const a = doc ? findSelected(doc) : null;
    // 長押しからの操作は、下のバーに統合した。注釈モードの「選ぶ」ツールのときだけ、この操作バーを使う
    selBar.hidden = !a || selecting;
    // 注釈ツールバーが出ているときは、その上に重ねる
    selBar.style.bottom = active && !bar.hidden ? `${bar.offsetHeight + 8}px` : '';
    for (const b of selColorButtons) b.setAttribute('aria-pressed', String(!!a && a.color === b.dataset.selColor));
    el('sel-text').textContent = SEL_TEXT;
    selUndo.disabled = undoStack.length === 0;
    syncQuickBar();
  }

  function endSelection(rerender = true): void {
    const had = selecting || selectedId !== null;
    selecting = false;
    selectedId = null;
    live = null;
    handleDrag = null;
    selBar.hidden = true;
    if (had && rerender) render();
  }

  /** 選ぶ状態にする。id があれば、その蛍光ペンを選んだ状態から始める */
  function startSelection(id: string | null): void {
    oneShot = null;
    clearTimeout(quickTimer);
    drag = null;
    preview?.remove();
    preview = null;
    selecting = !active; // 注釈モードのときは、「選ぶ」ツールの動きになる
    selectedId = id;
    render();
    syncSelUi();
  }

  /** タップした位置にある蛍光ペン(いちばん上のもの)を選ぶ。何もなければ、選択を外す */
  function selectAt(p: NormPoint, g: Geom, doc: BookSyncDocument): void {
    const tol = 12 * unitsPerPx(g);
    const hits = visibleAnnotations(doc.annotations).filter((a) => a.page.pdfPage === g.spec.pdfPage && a.kind !== 'memo' && hitHighlight(a, p, tol, g.page));
    const top = hits[hits.length - 1];
    selectedId = top ? top.id : null; // 何もない所のタップは、選択を外すだけ(長押しからの状態は、「完了」まで続く)
    render();
    syncSelUi();
  }

  function setSelectedColor(c: AnnotationColor): void {
    const doc = deps.getDoc();
    const a = doc ? findSelected(doc) : null;
    if (!doc || !a || a.color === c) return;
    const id = a.id;
    const prev = a.color;
    apply((l) => setAnnotationColor(l, id, c));
    record({ undo: () => apply((l) => setAnnotationColor(l, id, prev)), redo: () => apply((l) => setAnnotationColor(l, id, c)) });
    syncSelUi();
  }

  function deleteHighlight(id: string): void {
    apply((l) => deleteAnnotation(l, id));
    record({ undo: () => apply((l) => restoreAnnotation(l, id)), redo: () => apply((l) => deleteAnnotation(l, id)) });
  }

  for (const b of selColorButtons) {
    b.style.setProperty('--swatch', COLORS[b.dataset.selColor as AnnotationColor].css);
    b.addEventListener('click', () => setSelectedColor(b.dataset.selColor as AnnotationColor));
  }
  selUndo.addEventListener('click', () => {
    undo();
    syncSelUi();
  });
  function deleteSelected(): void {
    if (!selectedId) return;
    const id = selectedId;
    // 長押しからの状態では、選んだ状態だけを外し、続けて選べるようにする。注釈モードでも同じ
    selectedId = null;
    live = null;
    deleteHighlight(id);
    syncSelUi();
  }
  el('sel-delete').addEventListener('click', deleteSelected);
  quickDelete.addEventListener('click', deleteSelected);
  el('sel-done').addEventListener('click', () => endSelection());

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
    } else if (t === 'select' && tap) {
      selectAt(n.p, g, doc);
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
    if (oneShot) armQuickIdle(); // 続けて引ける。引き終えるたびに、自動で戻るまでの時間を数え直す
  }

  // ---- メモの入力 ----
  let editing: { id?: string; at?: NormPoint; page?: PageRef; prevText?: string } | null = null;

  function openEditor(e: { id?: string; text?: string; at?: NormPoint; page?: PageRef }): void {
    editing = { id: e.id, at: e.at, page: e.page, prevText: e.text };
    memoText.value = e.text ?? '';
    disarmDelete();
    memoDelete.hidden = !e.id;
    editor.hidden = false;
    memoText.focus();
  }

  function closeEditor(): void {
    disarmDelete();
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

  // 削除は2回押し: 1回目で「もう一度押すと削除します」に変わり、数秒で元に戻る。2回目で削除する
  const DELETE_ARM_MS = 4000;
  let deleteArmTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmDelete(): void {
    clearTimeout(deleteArmTimer);
    memoDelete.classList.remove('armed');
    memoDelete.textContent = 'このメモを削除…';
  }

  function deleteMemo(): void {
    const id = editing?.id;
    if (!deps.getDoc() || !id) return;
    if (!memoDelete.classList.contains('armed')) {
      memoDelete.classList.add('armed');
      memoDelete.textContent = 'もう一度押すと削除します';
      clearTimeout(deleteArmTimer);
      deleteArmTimer = setTimeout(disarmDelete, DELETE_ARM_MS);
      return;
    }
    disarmDelete();
    const op: HistoryOp = { undo: () => apply((l) => restoreAnnotation(l, id)), redo: () => apply((l) => deleteAnnotation(l, id)) };
    apply((l) => deleteAnnotation(l, id));
    record(op);
    closeEditor();
    deps.onDeleted?.('メモを削除しました', () => {
      // 履歴の最後に残っていれば、履歴からも外す(「戻す」を二重に押さないように)
      const i = undoStack.indexOf(op);
      if (i >= 0) {
        undoStack.splice(i, 1);
        redoStack.push(op);
        renderBar();
      }
      op.undo();
    });
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
  // 長押しでメニューが指の下に出たとき、指を離した操作(ブラウザが click を発生させる)で、項目を選んだことにしない。
  // メニューの上で、新しく触れた(pointerdown)あとの click だけを受け付ける。キーボード操作(click の detail=0)は、そのまま受け付ける。
  let menuArmed = false;
  menu.addEventListener('pointerdown', () => (menuArmed = true), true);
  const strayClick = (e: MouseEvent): boolean => e.detail > 0 && !menuArmed;
  const onOutside = (e: Event) => {
    if (menu.contains(e.target as Node)) return;
    closeMenu();
    // メニューを閉じるためのクリックは、ページ送りやメニュー表示としては扱わない
    e.stopPropagation();
  };

  /** メニューを開いた位置にある蛍光ペン(あれば)。その蛍光ペンを直す項目を出す */
  let menuTarget: string | null = null;

  function openContextMenu(x: number, y: number): void {
    menuPoint = { x, y };
    menuArmed = false;
    menuTarget = null;
    const doc = deps.getDoc();
    const n = toNorm(x, y);
    if (doc && n) {
      const tol = 12 * unitsPerPx(n.g);
      const hits = visibleAnnotations(doc.annotations).filter((a) => a.page.pdfPage === n.g.spec.pdfPage && a.kind !== 'memo' && hitHighlight(a, n.p, tol, n.g.page));
      const top = hits[hits.length - 1];
      menuTarget = top && top.kind !== 'memo' ? top.id : null;
      const t = top && top.kind !== 'memo' ? top : null;
      for (const b of ctxTargetColorButtons) b.setAttribute('aria-pressed', String(!!t && t.color === b.dataset.ctxTcolor));
    }
    ctxTarget.hidden = menuTarget === null;
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

  /** 続けて引く状態にする(選んでいたら、選択は外す) */
  function beginOneShot(t: DrawTool): void {
    closeMenu();
    if (selecting || selectedId !== null) endSelection();
    drag = null;
    preview?.remove();
    preview = null;
    oneShot = t;
    renderBar();
    syncQuickBar();
    armQuickIdle();
  }

  function cancelOneShot(): void {
    drag = null;
    preview?.remove();
    preview = null;
    endSession();
  }

  for (const b of menu.querySelectorAll<HTMLButtonElement>('[data-ctx]')) {
    b.addEventListener('click', (e) => {
      if (strayClick(e)) return; // 指を離しただけの click は無視する
      const act = b.dataset.ctx;
      if (act === 'memo') {
        closeMenu();
        placeMemoAt(menuPoint.x, menuPoint.y);
      } else if (act === 'rect' || act === 'stroke') {
        beginOneShot(act);
      } else if (act === 'selectmode') {
        closeMenu();
        startSelection(null); // 蛍光ペンの上でなくても、選ぶ状態にできる(細い線を、長押しで狙わなくてよい)
      } else if (act === 'select' && menuTarget) {
        const id = menuTarget;
        closeMenu();
        startSelection(id);
      } else if (act === 'delete' && menuTarget) {
        const id = menuTarget;
        closeMenu();
        deleteHighlight(id);
      }
    });
  }
  for (const b of ctxTargetColorButtons) {
    b.style.setProperty('--swatch', COLORS[b.dataset.ctxTcolor as AnnotationColor].css);
    b.addEventListener('click', (e) => {
      if (strayClick(e) || !menuTarget) return;
      const id = menuTarget;
      const c = b.dataset.ctxTcolor as AnnotationColor;
      const a = deps.getDoc()?.annotations.find((x) => x.id === id);
      if (!a || a.kind === 'memo') return;
      const prev = a.color;
      closeMenu();
      if (prev === c) return;
      apply((l) => setAnnotationColor(l, id, c));
      record({ undo: () => apply((l) => setAnnotationColor(l, id, prev)), redo: () => apply((l) => setAnnotationColor(l, id, c)) });
    });
  }
  for (const b of menuColorButtons) {
    b.style.setProperty('--swatch', COLORS[b.dataset.ctxColor as AnnotationColor].css);
    b.addEventListener('click', (e) => {
      if (strayClick(e)) return;
      color = b.dataset.ctxColor as AnnotationColor;
      write(COLOR_STORE, color);
      renderMenuColors();
      renderQuickColors();
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
    quickUndo.disabled = undoStack.length === 0;
    selUndo.disabled = undoStack.length === 0;
    hint.textContent = HINTS[tool] + COMMON_HINT;
    syncQuickBar();
  }
  for (const b of toolButtons) {
    b.addEventListener('click', () => {
      tool = b.dataset.tool as Tool;
      write(TOOL_KEY, tool);
      if (tool !== 'select') endSelection(); // 「選ぶ」以外のツールに替えたら、選択を外す
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
  for (const b of quickColorButtons) {
    b.style.setProperty('--swatch', COLORS[b.dataset.quickColor as AnnotationColor].css);
    b.addEventListener('click', () => {
      const c = b.dataset.quickColor as AnnotationColor;
      if (selecting && selectedId) {
        setSelectedColor(c); // 蛍光ペンを選んでいる間は、その蛍光ペンの色を変える
        return;
      }
      color = c;
      write(COLOR_STORE, color);
      renderMenuColors();
      renderBar();
      if (oneShot) armQuickIdle();
    });
  }
  for (const b of quickToolButtons) {
    b.addEventListener('click', () => {
      const t = b.dataset.quickTool;
      if (t === 'select') startSelection(null);
      else if (t === 'rect' || t === 'stroke') beginOneShot(t);
    });
  }
  quickUndo.addEventListener('click', () => {
    undo();
    syncSelUi();
    if (oneShot) armQuickIdle();
  });
  el('quick-done').addEventListener('click', () => endSession());
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
    endSelection();
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
    oneShot = null;
    clearTimeout(quickTimer);
    endSelection(false);
    quickBar.hidden = true;
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
    isOneShot: () => oneShot !== null || selecting,
    closeEditor,
    /** ジェスチャーに渡す、描画の操作 */
    draw: { drawActive: () => active || oneShot !== null || selecting, drawOffset: () => deps.touchOffset?.() ?? { x: 0, y: 0 }, onDrawStart, onDrawMove, onDrawEnd },
  };
}
