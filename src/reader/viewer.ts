import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { ViewSpec } from '../model/layout';
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

  /** 指定範囲をフィット表示する。成功時はフィット時のサイズ、追い越された場合は null。 */
  async show(spec: ViewSpec): Promise<Size | null> {
    const token = ++this.showToken;
    this.current?.cancel();
    const r = await this.render(spec, token);
    if (!r || token !== this.showToken) return null;
    this.canvas?.remove();
    this.canvas = r.canvas;
    this.pageEl.prepend(r.canvas);
    this.pageEl.style.width = `${r.fit.w}px`;
    this.pageEl.style.height = `${r.fit.h}px`;
    return r.fit;
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

    const rendered: Rendered = { canvas, fit };
    this.cache.set(key, rendered);
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return rendered;
  }
}
