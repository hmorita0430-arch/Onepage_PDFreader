/**
 * タッチ・マウスの操作を、意味のある操作に変換する(D-8, O-1, O-3)。
 *
 * - 画面の左右の端のタップ: すぐ通知(ページ送り)。ズーム中も同じ。
 * - 中央のタップ: ダブルタップでないと確定してから通知(メニュー)。
 * - 中央のダブルタップ(ダブルクリック): ズームの切り替え。
 * - ズーム中のドラッグ: 表示位置の移動のみ。スワイプでのページ送りは行わない。
 * - ズームしていないときの横スワイプ: ページ送り。
 * - ピンチ、マウスホイール: ズーム。
 */
export interface GestureHandlers {
  isZoomed(): boolean;
  isCenter(xFraction: number): boolean;
  onEdgeTap(xFraction: number): void;
  onCenterTap(): void;
  /** 座標は el の左上を原点とする */
  onDoubleTap(x: number, y: number): void;
  onSwipe(dx: number): void;
  onPan(dx: number, dy: number): void;
  onZoom(factor: number, x: number, y: number): void;
}

const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 500;
const SWIPE_MIN = 50;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 40;
const CENTER_TAP_DELAY = 280;

export function attachGestures(el: HTMLElement, h: GestureHandlers): void {
  const pts = new Map<number, { x: number; y: number }>();
  let gesture: { sx: number; sy: number; st: number; moved: boolean; multi: boolean } | null = null;
  let pinchDist = 0;
  let pinchMid = { x: 0, y: 0 };
  let lastCenterTap: { t: number; x: number; y: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
  };

  const two = (): { dist: number; mid: { x: number; y: number } } => {
    const [a, b] = [...pts.values()];
    if (!a || !b) return { dist: 0, mid: { x: 0, y: 0 } };
    const r = el.getBoundingClientRect();
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top } };
  };

  const tap = (x: number, y: number, width: number) => {
    const xf = x / width;
    if (!h.isCenter(xf)) {
      clearTimeout(pending);
      lastCenterTap = null;
      h.onEdgeTap(xf);
      return;
    }
    const now = performance.now();
    if (lastCenterTap && now - lastCenterTap.t < DOUBLE_TAP_MS && Math.hypot(x - lastCenterTap.x, y - lastCenterTap.y) < DOUBLE_TAP_DIST) {
      clearTimeout(pending);
      lastCenterTap = null;
      h.onDoubleTap(x, y);
      return;
    }
    lastCenterTap = { t: now, x, y };
    clearTimeout(pending);
    pending = setTimeout(() => {
      lastCenterTap = null;
      h.onCenterTap();
    }, CENTER_TAP_DELAY);
  };

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      gesture = { sx: e.clientX, sy: e.clientY, st: performance.now(), moved: false, multi: false };
    } else if (gesture) {
      gesture.multi = true;
      const t = two();
      pinchDist = t.dist;
      pinchMid = t.mid;
    }
  });

  el.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev || !gesture) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size >= 2) {
      const t = two();
      if (pinchDist > 0 && t.dist > 0) h.onZoom(t.dist / pinchDist, t.mid.x, t.mid.y);
      h.onPan(t.mid.x - pinchMid.x, t.mid.y - pinchMid.y);
      pinchDist = t.dist;
      pinchMid = t.mid;
      gesture.moved = true;
      return;
    }
    if (gesture.multi) return;
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > TAP_MAX_MOVE) gesture.moved = true;
    if (gesture.moved && h.isZoomed()) h.onPan(e.clientX - prev.x, e.clientY - prev.y);
  });

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size > 0 || !gesture) return;
    const g = gesture;
    gesture = null;
    if (cancelled || g.multi) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && performance.now() - g.st <= TAP_MAX_MS) {
      const p = rel(e);
      tap(p.x, p.y, p.w);
    } else if (g.moved && !h.isZoomed() && Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
      h.onSwipe(dx);
    }
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const p = rel(e);
      h.onZoom(Math.exp(-e.deltaY * unit * 0.0015), p.x, p.y);
    },
    { passive: false },
  );
}
