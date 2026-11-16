import { awakeMs, type AwakeMode } from '../model/awake';

/**
 * 読書中に画面を点けたままにする(Screen Wake Lock)。
 * - 本を開いている間だけ。最後の操作から、設定の時間を過ぎたら手放し、端末の設定に戻る。操作すると、また点けておく。
 * - 画面が隠れる(別のアプリへ移る等)と、ブラウザが自動で手放す。戻ってきたら、取り直す。
 * - 端末・ブラウザが対応していない、省電力モードで拒否された、などのときは、何もしない(読書は止めない)。
 */
type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void };
type WakeLockApi = { request(type: 'screen'): Promise<Sentinel> };

export type AwakeStatus = 'unsupported' | 'idle' | 'holding' | 'waiting' | 'denied';

export function createAwake(deps: { getMode(): AwakeMode; onStatus?(s: AwakeStatus): void }) {
  const api = (): WakeLockApi | undefined => (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  let reading = false;
  let sentinel: Sentinel | null = null;
  let requesting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: AwakeStatus = api() ? 'idle' : 'unsupported';

  const setStatus = (s: AwakeStatus) => {
    if (s === status) return;
    status = s;
    deps.onStatus?.(s);
  };

  async function acquire(): Promise<void> {
    const wl = api();
    if (!wl) return setStatus('unsupported');
    if (!reading || document.hidden || sentinel || requesting) return;
    if (awakeMs(deps.getMode()) === 0) return; // 標準: 端末の設定どおり
    requesting = true;
    try {
      const s = await wl.request('screen');
      if (!reading || awakeMs(deps.getMode()) === 0) {
        void s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener('release', () => {
        if (sentinel === s) sentinel = null; // 画面が隠れた等で、ブラウザが手放した
      });
      setStatus('holding');
    } catch {
      setStatus('denied'); // 省電力モード等で拒否された。次の操作で、もう一度試す
    } finally {
      requesting = false;
    }
  }

  async function release(): Promise<void> {
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) await s.release().catch(() => undefined);
  }

  function arm(): void {
    clearTimeout(timer);
    const ms = awakeMs(deps.getMode());
    if (ms === null || ms === 0) return;
    timer = setTimeout(() => {
      void release();
      setStatus('waiting'); // 時間が過ぎた。端末の設定どおりに暗くなる。次の操作で、また点けておく
    }, ms);
  }

  /** 利用者の操作があった */
  function touch(): void {
    if (!reading) return;
    if (awakeMs(deps.getMode()) === 0) return;
    void acquire();
    arm();
  }

  for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) document.addEventListener(t, touch, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && reading) touch(); // 戻ってきた。ブラウザは、隠れたときに手放している
    if (document.hidden) clearTimeout(timer);
  });

  return {
    /** 本を開いた */
    start(): void {
      reading = true;
      touch();
    },
    /** 本を閉じた */
    stop(): void {
      reading = false;
      clearTimeout(timer);
      void release();
      setStatus(api() ? 'idle' : 'unsupported');
    },
    /** 設定を変えた(読書中なら、すぐ反映する) */
    modeChanged(): void {
      clearTimeout(timer);
      if (!reading) return;
      if (awakeMs(deps.getMode()) === 0) {
        void release();
        setStatus('idle');
      } else touch();
    },
    supported: (): boolean => api() !== undefined,
    status: (): AwakeStatus => status,
  };
}
