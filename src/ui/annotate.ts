import {
  COLORS,
  COLOR_KEYS,
  STROKE_WIDTH,
  addMemo,
  addRect,
  addStroke,
  centerOf,
  deleteAnnotation,
  hitHighlight,
  pointToNorm,
  rectFrom,
  sideAt,
  updateMemoText,
  visibleAnnotations,
} from '../model/annotations';
import type { ViewSpec } from '../model/layout';
import type { AnnotationColor, BookSyncDocument, NormPoint, PageRef } from '../model/types';
import { layout, type Size, type ViewState } from '../reader/view';

/**
 * 注釈(蛍光ペン・位置つきメモ)の画面: ツールバー、ページ上への描画、メモの入力。
 * 座標は元画像基準の正規化座標で持つ(4章)。ズーム・移動・分割・トリミングが変わっても動かない。
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

const NS = 'http://www.w3.org/2000/svg';
const TOOL_KEY = 'ann-tool:v1';
const COLOR_STORE = 'ann-color:v1';
const HINTS: Record<Tool, string> = {
  rect: 'ドラッグで四角く囲みます。',
  stroke: '指(マウス)でなぞって線を引きます。',
  memo: 'メモを置く場所をタップします。置いたメモはタップで開けます。',
  erase: '消したい蛍光ペンをタップします。メモは、ピンをタップして削除します。',
};
const COMMON_HINT = ' ページ送りは ◀ ▶。拡大は2本指(ホイール)、Shift+ドラッグで移動。';

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

export function createAnnotator(deps: AnnotateDeps, pageEl: HTMLElement) {
  const bar = el('ann-bar');
  const hint = el('ann-hint');
  const editor = el('memo-editor');
  const memoText = el<HTMLTextAreaElement>('memo-text');
  const memoDelete = el<HTMLButtonElement>('memo-delete');
  const toolButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  const colorButtons = [...bar.querySelectorAll<HTMLButtonElement>('[data-color]')];

  let active = false;
  let tool: Tool = (['rect', 'stroke', 'memo', 'erase'] as const).find((t) => t === read(TOOL_KEY)) ?? 'rect';
  let color: AnnotationColor = COLOR_KEYS.find((c) => c === read(COLOR_STORE)) ?? 'yellow';

  // ---- ページ上の描画層 ----
  const layer = document.createElement('div');
  layer.className = 'ann-layer';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const pins = document.createElement('div');
  layer.append(svg, pins);
  pageEl.append(layer);

  function highlightEl(a: { kind: 'rect'; x: number; y: number; w: number; h: number; css: string } | { kind: 'stroke'; points: string; width: number; css: string }): SVGElement {
    if (a.kind === 'rect') {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(a.x));
      r.setAttribute('y', String(a.y));
      r.setAttribute('width', String(a.w));
      r.setAttribute('height', String(a.h));
      r.setAttribute('fill', a.css);
      r.setAttribute('class', 'hl');
      return r;
    }
    const p = document.createElementNS(NS, 'polyline');
    p.setAttribute('points', a.points);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', a.css);
    p.setAttribute('stroke-width', String(a.width));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    p.setAttribute('class', 'hl');
    return p;
  }

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
        svg.append(highlightEl({ kind: 'rect', x: a.rect.x * W, y: a.rect.y * H, w: a.rect.w * W, h: a.rect.h * H, css: COLORS[a.color].css }));
      } else if (a.kind === 'highlight-stroke') {
        const pts = a.points.map((p) => `${p.x * W},${p.y * H}`).join(' ');
        svg.append(highlightEl({ kind: 'stroke', points: pts, width: a.width * W, css: COLORS[a.color].css }));
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
  let preview: SVGElement | null = null;
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

  function onDrawStart(x: number, y: number): void {
    const n = toNorm(x, y);
    if (!n || !active) return;
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
    if (tool === 'rect') {
      const r = rectFrom(drag.start, n.p);
      preview?.remove();
      preview = highlightEl({ kind: 'rect', x: r.x * W, y: r.y * H, w: r.w * W, h: r.h * H, css });
      preview.setAttribute('class', 'hl preview');
      svg.append(preview);
    } else if (tool === 'stroke') {
      if (Math.hypot(x - drag.last.x, y - drag.last.y) < 3) return; // 細かすぎる点は間引く
      drag.last = { x, y };
      drag.points.push(n.p);
      preview?.remove();
      preview = highlightEl({ kind: 'stroke', points: drag.points.map((p) => `${p.x * W},${p.y * H}`).join(' '), width: STROKE_WIDTH * W, css });
      preview.setAttribute('class', 'hl preview');
      svg.append(preview);
    }
  }

  function onDrawEnd(x: number, y: number, cancelled: boolean): void {
    const d = drag;
    drag = null;
    preview?.remove();
    preview = null;
    const doc = deps.getDoc();
    const n = toNorm(x, y);
    if (!d || cancelled || !doc || !n) return;
    const tap = d.moved < 10;

    // 四角は、縦横とも一定以上ドラッグしたときだけ作る(横にだけ動かして、高さ0の見えない蛍光ペンを作らない)
    if (tool === 'rect' && Math.abs(x - d.sx) >= 6 && Math.abs(y - d.sy) >= 6) {
      const r = rectFrom(d.start, n.p);
      doc.annotations = addRect(doc.annotations, { page: pageRef(centerOf(r), n.g, doc), color, rect: r });
      deps.commit();
      render();
    } else if (tool === 'stroke' && d.points.length >= 2) {
      const pts = [...d.points, n.p];
      const mid = pts[Math.floor(pts.length / 2)]!;
      doc.annotations = addStroke(doc.annotations, { page: pageRef(mid, n.g, doc), color, points: pts });
      deps.commit();
      render();
    } else if (tool === 'memo' && tap) {
      openEditor({ at: n.p, page: pageRef(n.p, n.g, doc) });
    } else if (tool === 'erase' && tap) {
      const { g } = n;
      // 画面上の約10pxを、元のPDFの単位に直した余裕
      const tol = (10 * g.spec.region.w * g.page.w) / (g.fit.w * g.view.z);
      const hits = visibleAnnotations(doc.annotations).filter(
        (a) => a.page.pdfPage === g.spec.pdfPage && hitHighlight(a, n.p, tol, g.page),
      );
      const top = hits[hits.length - 1]; // 最後に作ったもの(いちばん上)
      if (top) {
        doc.annotations = deleteAnnotation(doc.annotations, top.id);
        deps.commit();
        render();
      }
    }
  }

  // ---- メモの入力 ----
  let editing: { id?: string; at?: NormPoint; page?: PageRef } | null = null;

  function openEditor(e: { id?: string; text?: string; at?: NormPoint; page?: PageRef }): void {
    editing = e;
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
    if (!doc || !e) return closeEditor();
    if (text === '') return closeEditor(); // 空のメモは作らない/変えない
    if (e.id) doc.annotations = updateMemoText(doc.annotations, e.id, text);
    else if (e.at && e.page) doc.annotations = addMemo(doc.annotations, { page: e.page, at: e.at, text });
    deps.commit();
    closeEditor();
    render();
  }

  function deleteMemo(): void {
    const doc = deps.getDoc();
    const id = editing?.id;
    if (!doc || !id) return;
    if (!confirm('このメモを削除しますか?')) return;
    doc.annotations = deleteAnnotation(doc.annotations, id);
    deps.commit();
    closeEditor();
    render();
  }

  el('memo-save').addEventListener('click', saveMemo);
  memoDelete.addEventListener('click', deleteMemo);
  el('memo-cancel').addEventListener('click', closeEditor);
  memoText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveMemo();
    if (e.key === 'Escape') closeEditor();
  });

  // ---- ツールバー ----
  function renderBar(): void {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    for (const b of colorButtons) b.setAttribute('aria-pressed', String(b.dataset.color === color));
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
  el('ann-prev').addEventListener('click', deps.prev);
  el('ann-next').addEventListener('click', deps.next);
  el('ann-done').addEventListener('click', () => exit());

  function enter(): void {
    if (active) return;
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
    bar.hidden = true;
    deps.onModeChange(false);
  }

  /** 本を閉じたとき */
  function reset(): void {
    active = false;
    drag = null;
    closeEditor();
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
    isActive: () => active,
    isEditorOpen: () => !editor.hidden,
    closeEditor,
    /** ジェスチャーに渡す、描画の操作 */
    draw: { drawActive: () => active, onDrawStart, onDrawMove, onDrawEnd },
  };
}
