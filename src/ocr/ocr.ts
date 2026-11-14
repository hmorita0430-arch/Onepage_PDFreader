import { normalizeOcrText, type Orientation } from './text';

/**
 * 端末内のOCR(tesseract.js)。画像は端末の外へ送らない。
 * 実行ファイル(worker・core)と日本語の学習データは、このアプリと同じ場所(/ocr/)から配る。
 * 重いので、使うときに初めて読み込み(動的import)、しばらく使わなければ手放す。
 */

const IDLE_MS = 60_000;
const ocrBase = () => new URL('ocr/', document.baseURI).href;

type Worker = import('tesseract.js').Worker;
let current: { lang: string; worker: Worker; psm: string } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();

export type OcrStatus = 'loading' | 'recognizing';

export class OcrUnavailableError extends Error {}

const LOAD_TIMEOUT_MS = 120_000;

async function preflight(urls: string[]): Promise<void> {
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u.split('/').pop()} を取得できません(${r.status})`);
    await r.arrayBuffer(); // 最後まで受け取る(サービスワーカーが保存を終えられるように)
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function acquire(lang: string, onStatus?: (s: OcrStatus) => void): Promise<Worker> {
  clearTimeout(idleTimer);
  if (current && current.lang === lang) return current.worker;
  if (current) {
    await current.worker.terminate().catch(() => undefined);
    current = null;
  }
  onStatus?.('loading');
  const base = ocrBase();
  const workerPath = `${base}worker.min.js`;
  const corePath = `${base}core/tesseract-core-simd-lstm.wasm.js`;
  try {
    // ファイルを取得できないとき、ワーカーの生成が終わらないことがあるため、先に取得を確かめる。
    // (オンラインの初回は、ここで取得・保存される。以後は、端末内のキャッシュから読む)
    await preflight([workerPath, corePath, `${base}lang/${lang}.traineddata`]);
    const { createWorker, OEM } = await import('tesseract.js');
    const worker = await withTimeout(
      createWorker(lang, OEM.LSTM_ONLY, { workerPath, corePath, langPath: `${base}lang`, gzip: false, workerBlobURL: false }),
      LOAD_TIMEOUT_MS,
      '時間がかかりすぎました',
    );
    current = { lang, worker, psm: '' };
    return worker;
  } catch (e) {
    throw new OcrUnavailableError(
      `文字の読み取りの準備に失敗しました。初めて使うときは通信が必要です(${(e as Error).message || '原因不明'})`,
    );
  }
}

/** 画像(キャンバス)の文字を読み取る。1度に1件ずつ処理する(重いため)。 */
export function recognize(
  canvas: HTMLCanvasElement,
  orientation: Orientation,
  onStatus?: (s: OcrStatus) => void,
): Promise<string> {
  const run = async (): Promise<string> => {
    const vertical = orientation === 'vertical';
    const worker = await acquire(vertical ? 'jpn_vert' : 'jpn', onStatus);
    // 縦書きは「縦書きの1ブロック(5)」、横書きは「1ブロック(6)」。範囲を絞って囲んだ画像のため
    const psm = vertical ? '5' : '6';
    if (current && current.psm !== psm) {
      await worker.setParameters({ tessedit_pageseg_mode: psm as never, preserve_interword_spaces: '0' });
      current.psm = psm;
    }
    onStatus?.('recognizing');
    try {
      const { data } = await worker.recognize(canvas);
      return normalizeOcrText(data.text);
    } finally {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void release(), IDLE_MS);
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** 読み取りの準備(ワーカー)を手放す。メモリを返すため */
export async function release(): Promise<void> {
  clearTimeout(idleTimer);
  const c = current;
  current = null;
  if (c) await c.worker.terminate().catch(() => undefined);
}
