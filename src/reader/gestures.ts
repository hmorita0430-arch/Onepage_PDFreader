/**
 * タッチ・マウスの操作を、意味のある操作に変換する(D-8, O-1, O-3)。
 *
 * - 上部の帯のタップ: すぐ通知(メニュー)。左上・右上でも、ページ送りにはならない。
 * - 帯の下の、左右の端のタップ: すぐ通知(ページ送り)。ズーム中も同じ。
 * - 帯の下の中央のタップ: ダブルタップでないと確定してから通知(メニュー)。
 * - 帯の下の中央のダブルタップ(ダブルクリック): ズームの切り替え。
 * - ズーム中のドラッグ: 表示位置の移動のみ。**スワイプでのページ送りは行わない**(タップとキーのみ)。
 * - ピンチ、マウスホイール: ズーム。
 * - 長押し(タッチ・ペン。約0.55秒、ほぼ動かさない): onLongPress(読書中にその場でメモを置くため)。
 * - 右クリック(マウス): onContextMenu(メモ・蛍光ペンのメニューを出すため)。
 * - 注釈の描画ツールを使用中(drawActive)は、1本指(マウスの左ボタン)の操作を描画として通知し、
 *   タップによるページ送り・スワイプは行わない(O-4)。2本指のピンチ・移動、Shift+ドラッグでの移動は使える。
 */
export interface GestureHandlers {
  /** 長押し(タッチ・ペン)。座標は el の左上を原点とする */
  onLongPress?(x: number, y: number): void;
  /** 右クリック(マウス) */
  onContextMenu?(x: number, y: number): void;
  /** 描画ツールの使用中か */
  drawActive?(): boolean;
  onDrawStart?(x: number, y: number): void;
  onDrawMove?(x: number, y: number): void;
  /** cancelled: 2本目の指が触れた等で、描画を中止した */
  onDrawEnd?(x: number, y: number, cancelled: boolean): void;
  isZoomed(): boolean;
  /**
   * タップした位置の領域。band=上部の帯(すぐメニュー)、edge=左右の端(すぐページ送り)、
   * center=中央(ダブルタップかどうかを待ってから、メニュー)
   */
  zone(xFraction: number, yFraction: number): 'band' | 'edge' | 'center';
  onEdgeTap(xFraction: number, yFraction: number): void;
  /** 上部の帯のタップ(メニューの出し入れ)。ダブルタップの判定を待たず、すぐ呼ぶ */
  onBandTap(): void;
  onCenterTap(): void;
  /** 座標は el の左上を原点とする */
  onDoubleTap(x: number, y: number): void;
  onPan(dx: number, dy: number): void;
  onZoom(factor: number, x: number, y: number): void;
}

const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 500;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 40;
const CENTER_TAP_DELAY = 280;
const LONG_PRESS_MS = 550;

export function attachGestures(el: HTMLElement, h: GestureHandlers): void {
  const pts = new Map<number, { x: number; y: number }>();
  let gesture: { sx: number; sy: number; st: number; moved: boolean; multi: boolean } | null = null;
  let pinchDist = 0;
  let pinchMid = { x: 0, y: 0 };
  let lastCenterTap: { t: number; x: number; y: number } | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let drawing = false;
  let lastPointerType = '';
  let longTimer: ReturnType<typeof setTimeout> | undefined;
  let longFired = false;

  const rel = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const two = (): { dist: number; mid: { x: number; y: number } } => {
    const [a, b] = [...pts.values()];
    if (!a || !b) return { dist: 0, mid: { x: 0, y: 0 } };
    const r = el.getBoundingClientRect();
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top } };
  };

  const tap = (x: number, y: number, width: number, height: number) => {
    const xf = x / width;
    const yf = y / height;
    const zone = h.zone(xf, yf);
    if (zone !== 'center') {
      clearTimeout(pending);
      lastCenterTap = null;
      if (zone === 'band') h.onBandTap();
      else h.onEdgeTap(xf, yf);
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
    lastPointerType = e.pointerType;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 右・中ボタンは、描画やタップとして扱わない
    el.setPointerCapture(e.pointerId);
    longFired = false;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      gesture = { sx: e.clientX, sy: e.clientY, st: performance.now(), moved: false, multi: false };
      // 描画ツール中は、1本指の操作を描画にする(Shift を押している間は、ズーム中の移動に使う)
      if (h.drawActive?.() && !e.shiftKey) {
        drawing = true;
        const p = rel(e);
        h.onDrawStart?.(p.x, p.y);
      } else if (e.pointerType !== 'mouse' && h.onLongPress) {
        // 長押し: ほとんど動かさずに押し続けたら、その場の操作(メモ)にする
        clearTimeout(longTimer);
        longTimer = setTimeout(() => {
          if (!gesture || gesture.moved || gesture.multi || pts.size !== 1) return;
          longFired = true;
          const r = el.getBoundingClientRect();
          h.onLongPress?.(gesture.sx - r.left, gesture.sy - r.top);
        }, LONG_PRESS_MS);
      }
    } else if (gesture) {
      clearTimeout(longTimer);
      if (drawing) {
        drawing = false;
        const p = rel(e);
        h.onDrawEnd?.(p.x, p.y, true); // 2本目の指: 描画を中止してピンチ操作に切り替える
      }
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
    if (drawing) {
      // 取りこぼした途中の点も使う(線がカクカクしないように)
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of coalesced.length > 0 ? coalesced : [e]) {
        const p = rel(ev);
        h.onDrawMove?.(p.x, p.y);
      }
      return;
    }
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > TAP_MAX_MOVE) {
      gesture.moved = true;
      clearTimeout(longTimer);
    }
    if (gesture.moved && h.isZoomed()) h.onPan(e.clientX - prev.x, e.clientY - prev.y);
  });

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size > 0 || !gesture) return;
    const g = gesture;
    gesture = null;
    clearTimeout(longTimer);
    if (longFired) {
      longFired = false; // 長押しで処理済み。続くタップ・スワイプとしては扱わない
      return;
    }
    if (drawing) {
      drawing = false;
      const p = rel(e);
      h.onDrawEnd?.(p.x, p.y, cancelled);
      return;
    }
    if (cancelled || g.multi) return;
    // 横スワイプでのページ送りは行わない(ページ送りはタップとキーのみ)
    if (!g.moved && performance.now() - g.st <= TAP_MAX_MS) {
      const p = rel(e);
      tap(p.x, p.y, p.w, p.h);
    }
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // ブラウザの標準メニューは出さない
    // タッチの長押しでも発生するが、そちらは onLongPress で処理済みなので、マウスのときだけ通知する
    if (lastPointerType === 'mouse' || lastPointerType === '') {
      const p = rel(e);
      h.onContextMenu?.(p.x, p.y);
    }
  });

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
