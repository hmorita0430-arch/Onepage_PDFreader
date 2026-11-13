import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { ViewSpec } from '../model/layout';
import type { NormRect } from '../model/types';
import type { Size } from './view';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/** 1枚の描画に使うピクセル数の上限(メモリ保護) */
const MAX_PIXELS = 10_000_000;
/** ズームしても粗くなりにくいよう、フィット表示の何倍の解像度で描くか */
const RENDER_BOOST = 2;
/** 描画済みページの保持数(表示中+前後を想定) */
const CACHE_SIZE = 3;

interface Rendered {
  canvas: HTMLCanvasElement;
  /** フィット表示したときのCSSサイズ */
  fit: Size;
  /** PDFページ(見開き1枚)全体の大きさ(PDFの単位)。注釈の座標を、拡大しても歪まない単位に直すために使う */
  page: Size;
}

/**
 * PDFの指定範囲を描画する。ズーム・移動は、ここで描いたページ要素(pageEl)に
 * CSS の transform を当てて行う(再描画しない)。
 */
export class PageViewer {
  private pdf: PDFDocumentProxy | undefined;
  private loadingTask: PDFDocumentLoadingTask | undefined;
  private cache = new Map<string, Rendered>();
  private current: RenderTask | undefined;
  private showToken = 0;
  private canvas: HTMLCanvasElement | undefined;
  /** ページ要素。拡大縮小の対象。注釈などの重ね描きはこの子要素に置く。 */
  readonly pageEl: HTMLDivElement;

  constructor(private readonly host: HTMLElement) {
    this.pageEl = document.createElement('div');
    this.pageEl.className = 'page';
    host.append(this.pageEl);
  }

  get numPages(): number {
    return this.pdf?.numPages ?? 0;
  }

  get box(): Size {
    return { w: Math.max(1, this.host.clientWidth), h: Math.max(1, this.host.clientHeight) };
  }

  async load(data: ArrayBuffer): Promise<void> {
    await this.close();
    this.loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
    this.pdf = await this.loadingTask.promise;
  }

  async close(): Promise<void> {
    this.current?.cancel();
    this.cache.clear();
    this.canvas?.remove();
    this.canvas = undefined;
    await this.loadingTask?.destroy();
    this.loadingTask = undefined;
    this.pdf = undefined;
  }

  /** 指定範囲をフィット表示する。成功時はフィット時のサイズとページの大きさ、追い越された場合は null。 */
  async show(spec: ViewSpec): Promise<{ fit: Size; page: Size } | null> {
    const token = ++this.showToken;
    this.current?.cancel();
    const r = await this.render(spec, token);
    if (!r || token !== this.showToken) return null;
    this.canvas?.remove();
    this.canvas = r.canvas;
    this.pageEl.prepend(r.canvas);
    this.pageEl.style.width = `${r.fit.w}px`;
    this.pageEl.style.height = `${r.fit.h}px`;
    return { fit: r.fit, page: r.page };
  }

  setTransform(tx: number, ty: number, scale: number): void {
    this.pageEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  /** 前後のページを先に描画しておく。 */
  async prefetch(specs: ViewSpec[]): Promise<void> {
    for (const spec of specs) {
      if (!this.pdf) return;
      await this.render(spec, null).catch(() => undefined);
    }
  }

  /** PDFページ(見開き1枚)全体の大きさ(PDFの単位) */
  async pageSize(pdfPage: number): Promise<Size> {
    const pdf = this.pdf;
    if (!pdf) return { w: 1, h: 1 };
    const page = await pdf.getPage(pdfPage);
    try {
      const v = page.getViewport({ scale: 1 });
      return { w: v.width, h: v.height };
    } finally {
      page.cleanup();
    }
  }

  /** 書き出し用: 指定範囲を、長辺が maxSide ピクセルになる大きさで描いたキャンバスを返す。 */
  async renderToCanvas(spec: ViewSpec, maxSide: number): Promise<{ canvas: HTMLCanvasElement; page: Size } | null> {
    const pdf = this.pdf;
    if (!pdf) return null;
    const { region } = spec;
    const page = await pdf.getPage(spec.pdfPage);
    try {
      const base = page.getViewport({ scale: 1 });
      const rw = base.width * region.w;
      const rh = base.height * region.h;
      let scale = maxSide / Math.max(rw, rh);
      scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (rw * rh)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width * region.w));
      canvas.height = Math.max(1, Math.round(viewport.height * region.h));
      await page.render({
        canvas,
        viewport,
        background: '#ffffff',
        transform: [1, 0, 0, 1, -viewport.width * region.x, -viewport.height * region.y],
      }).promise;
      return { canvas, page: { w: base.width, h: base.height } };
    } finally {
      page.cleanup();
    }
  }

  /**
   * 指定した範囲(元画像基準の正規化)に含まれる、PDFの文字データ(OCR等)を返す。範囲ごとに1件。
   * ページに文字データが無ければ、すべて null。文字の並びはPDF内の順(縦書きでも内容順)。
   */
  async textInRegions(pdfPage: number, regions: NormRect[]): Promise<(string | null)[]> {
    const pdf = this.pdf;
    if (!pdf) return regions.map(() => null);
    const page = await pdf.getPage(pdfPage);
    try {
      const content = await page.getTextContent();
      const vp = page.getViewport({ scale: 1 });
      const items = content.items.flatMap((it) => {
        if (!('str' in it) || it.str.trim() === '') return [];
        const [x0, y0] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        const [x1, y1] = vp.convertToViewportPoint(it.transform[4] + it.width, it.transform[5] + it.height);
        return [{ str: it.str, cx: (x0 + x1) / 2 / vp.width, cy: (y0 + y1) / 2 / vp.height }];
      });
      if (items.length === 0) return regions.map(() => null);
      return regions.map((r) => {
        const inside = items.filter((i) => i.cx >= r.x && i.cx <= r.x + r.w && i.cy >= r.y && i.cy <= r.y + r.h);
        return inside.length === 0 ? null : inside.map((i) => i.str).join('');
      });
    } finally {
      page.cleanup();
    }
  }

  /** サムネイル用の小さな画像(JPEG)を作り、オブジェクトURLで返す。呼び出し側が revoke する。 */
  async renderThumbnail(spec: ViewSpec, maxW: number, maxH: number): Promise<string | null> {
    const pdf = this.pdf;
    if (!pdf) return null;
    const { region } = spec;
    const page = await pdf.getPage(spec.pdfPage);
    try {
      const base = page.getViewport({ scale: 1 });
      const rw = base.width * region.w;
      const rh = base.height * region.h;
      const scale = Math.min(maxW / rw, maxH / rh);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width * region.w));
      canvas.height = Math.max(1, Math.round(viewport.height * region.h));
      await page.render({
        canvas,
        viewport,
        background: '#ffffff',
        transform: [1, 0, 0, 1, -viewport.width * region.x, -viewport.height * region.y],
      }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
      canvas.width = 0; // メモリを早めに手放す
      return blob ? URL.createObjectURL(blob) : null;
    } finally {
      page.cleanup();
    }
  }

  private async render(spec: ViewSpec, token: number | null): Promise<Rendered | null> {
    const pdf = this.pdf;
    if (!pdf) return null;
    const { region } = spec;
    const box = this.box;
    const dpr = window.devicePixelRatio || 1;
    const key = [spec.pdfPage, region.x, region.y, region.w, region.h, box.w, box.h, dpr].map((v) => (typeof v === 'number' ? +v.toFixed(5) : v)).join('|');

    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // LRU: 最近使ったものを末尾へ
      return hit;
    }

    const page = await pdf.getPage(spec.pdfPage);
    if (token !== null && token !== this.showToken) return null;

    const base = page.getViewport({ scale: 1 });
    const regionW = base.width * region.w;
    const regionH = base.height * region.h;
    const fitScale = Math.min(box.w / regionW, box.h / regionH);
    let scale = fitScale * dpr * RENDER_BOOST;
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (regionW * regionH)));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width * region.w));
    canvas.height = Math.max(1, Math.round(viewport.height * region.h));
    const fit: Size = { w: regionW * fitScale, h: regionH * fitScale };
    canvas.style.width = `${fit.w}px`;
    canvas.style.height = `${fit.h}px`;
    canvas.setAttribute('role', 'img');

    const task = page.render({
      canvas,
      viewport,
      transform: [1, 0, 0, 1, -viewport.width * region.x, -viewport.height * region.y],
    });
    if (token !== null) this.current = task;
    try {
      await task.promise;
    } catch (e) {
      if ((e as { name?: string }).name === 'RenderingCancelledException') return null;
      throw e;
    } finally {
      page.cleanup();
    }

    const rendered: Rendered = { canvas, fit, page: { w: base.width, h: base.height } };
    this.cache.set(key, rendered);
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return rendered;
  }
}
