import { averageOffset, describeOffset, isNoOffset, NO_OFFSET, spread, type Offset, type Sample } from '../model/touchoffset';

/**
 * 描画位置の確認。目印(+)の中心を指で触れてもらい、アプリが受け取った位置との差を測る。
 * 平均した差を、指で描くときの補正として保存できる。上部・左右・下部の目印を使い、場所による違いも見る。
 */
export interface CalibrationDeps {
  current(): Offset;
  /** 「この補正を使う」「補正をなしにする」を押した */
  apply(o: Offset): void;
}

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} がありません`);
  return e as T;
};

/** 目印の位置(パッドの幅・高さに対する割合)。画面の上部・下部・左右を含める */
export const CALIB_TARGETS: ReadonlyArray<{ x: number; y: number; label: string }> = [
  { x: 0.5, y: 0.5, label: '中央' },
  { x: 0.5, y: 0.1, label: '上部の中央' },
  { x: 0.2, y: 0.2, label: '左上' },
  { x: 0.8, y: 0.2, label: '右上' },
  { x: 0.2, y: 0.88, label: '左下' },
  { x: 0.8, y: 0.88, label: '右下' },
];
/** ばらつきがこれより大きいと、1つの補正では合わないと知らせる(画面のピクセル) */
export const SPREAD_WARN_PX = 14;

export function createCalibration(deps: CalibrationDeps) {
  const root = el('calib');
  const pad = el('calib-pad');
  const msg = el('calib-msg');
  const applyBtn = el<HTMLButtonElement>('calib-apply');
  const retryBtn = el<HTMLButtonElement>('calib-retry');
  const resetBtn = el<HTMLButtonElement>('calib-reset');
  const closeBtn = el<HTMLButtonElement>('calib-close');
  let samples: Sample[] = [];
  let step = 0;
  let result: Offset | null = null;
  let touchSeen = false;

  const marker = document.createElement('div');
  marker.className = 'calib-marker';
  marker.setAttribute('aria-hidden', 'true');

  // 目印・点は、パッドの内側(枠線を除く)を基準に置かれる。狙いの位置も、同じ基準で数える(枠線の1px分のずれを出さない)
  function origin(): { left: number; top: number } {
    const r = pad.getBoundingClientRect();
    return { left: r.left + pad.clientLeft, top: r.top + pad.clientTop };
  }

  function target(): { x: number; y: number } {
    const o = origin();
    const t = CALIB_TARGETS[step]!;
    return { x: o.left + pad.clientWidth * t.x, y: o.top + pad.clientHeight * t.y };
  }

  function placeMarker(): void {
    const t = CALIB_TARGETS[step];
    if (!t) return;
    marker.style.left = `${t.x * pad.clientWidth}px`;
    marker.style.top = `${t.y * pad.clientHeight}px`;
    pad.append(marker);
  }

  function showStep(): void {
    const t = CALIB_TARGETS[step];
    if (!t) return finish();
    msg.textContent = `${step + 1}/${CALIB_TARGETS.length}: ${t.label}の「+」の中心に、いつも描くときの指で、軽く触れてください。`;
    placeMarker();
  }

  function dot(x: number, y: number, kind: 'aim' | 'hit'): void {
    const o = origin();
    const d = document.createElement('div');
    d.className = `calib-dot ${kind}`;
    d.style.left = `${x - o.left}px`;
    d.style.top = `${y - o.top}px`;
    pad.append(d);
  }

  function finish(): void {
    marker.remove();
    const avg = averageOffset(samples);
    const sp = spread(samples);
    result = avg;
    const lines = [
      `平均のずれ: 狙いより ${isNoOffset(avg) ? 'ずれなし' : `${describeOffset({ x: -avg.x, y: -avg.y })}`}に触れていました。`,
      `補正: ${describeOffset(avg)}(描く位置に足します)。`,
    ];
    if (sp > SPREAD_WARN_PX) lines.push(`場所によってずれ方が違います(ばらつき ${sp}px)。補正しても合わない場所があります。やり直しをおすすめします。`);
    if (!touchSeen) lines.push('注意: 指(タッチ)での操作ではありませんでした。この補正は、指で描くときだけ使われます。');
    msg.textContent = lines.join('\n');
    applyBtn.disabled = false;
  }

  function reset(): void {
    samples = [];
    step = 0;
    result = null;
    touchSeen = false;
    applyBtn.disabled = true;
    for (const d of pad.querySelectorAll('.calib-dot, .calib-line')) d.remove();
    showStep();
  }

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (result || step >= CALIB_TARGETS.length) return;
    const aim = target();
    samples.push({ aim, hit: { x: e.clientX, y: e.clientY } });
    if (e.pointerType === 'touch') touchSeen = true;
    dot(aim.x, aim.y, 'aim');
    dot(e.clientX, e.clientY, 'hit');
    step++;
    marker.remove();
    if (step >= CALIB_TARGETS.length) finish();
    else setTimeout(showStep, 350); // 触れた点を、少し見せてから、次の目印へ
  });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  applyBtn.addEventListener('click', () => {
    if (!result) return;
    deps.apply(result);
    msg.textContent = `補正を保存しました(${describeOffset(result)})。以後、指で描く線・取っ手の操作に使われます。`;
    applyBtn.disabled = true;
  });
  resetBtn.addEventListener('click', () => {
    deps.apply(NO_OFFSET);
    msg.textContent = '補正をなしにしました。';
  });
  retryBtn.addEventListener('click', reset);

  function open(): void {
    root.hidden = false;
    const cur = deps.current();
    reset();
    msg.dataset.current = describeOffset(cur);
    // 最初の案内に、いまの補正を添える
    msg.textContent = `現在の補正: ${describeOffset(cur)}\n${msg.textContent}`;
  }

  function close(): void {
    root.hidden = true;
    marker.remove();
  }
  closeBtn.addEventListener('click', close);

  return { open, close, isOpen: () => !root.hidden };
}
