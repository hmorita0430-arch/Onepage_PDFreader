import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { regionOf } from '../model/pages';
import type { BookSettings, NormRect, PageRef } from '../model/types';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/** 1枚の描画に使うピクセル数の上限(メモリ保護) */
const MAX_PIXELS = 16_000_000;
/** 描画済みページの保持数(表示中+前後を想定) */
const CACHE_SIZE = 4;

interface Box {
  w: number;
  h: number;
}

export class PageViewer {
  private pdf: PDFDocumentProxy | undefined;
  private loadingTask: PDFDocumentLoadingTask | undefined;
  private cache = new Map<string, HTMLCanvasElement>();
  private current: RenderTask | undefined;
  private showToken = 0;

  constructor(private readonly host: HTMLElement) {}

  get numPages(): number {
    return this.pdf?.numPages ?? 0;
  }

  async load(data: ArrayBuffer): Promise<void> {
    await this.close();
    this.loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
    this.pdf = await this.loadingTask.promise;
  }

  async close(): Promise<void> {
    this.current?.cancel();
    this.cache.clear();
    this.host.replaceChildren();
    await this.loadingTask?.destroy();
    this.loadingTask = undefined;
    this.pdf = undefined;
  }

  /** 指定ページをフィット表示する(D-4)。描画が追い越された場合は false。 */
  async show(ref: PageRef, settings: BookSettings): Promise<boolean> {
    const token = ++this.showToken;
    this.current?.cancel();
    const canvas = await this.render(ref, settings, token);
    if (!canvas || token !== this.showToken) return false;
    this.host.replaceChildren(canvas);
    return true;
  }

  /** 前後のページを先に描画しておく。 */
  async prefetch(refs: PageRef[], settings: BookSettings): Promise<void> {
    for (const ref of refs) {
      if (!this.pdf) return;
      await this.render(ref, settings, null).catch(() => undefined);
    }
  }

  private boxSize(): Box {
    return { w: Math.max(1, this.host.clientWidth), h: Math.max(1, this.host.clientHeight) };
  }

  private async render(ref: PageRef, settings: BookSettings, token: number | null): Promise<HTMLCanvasElement | null> {
    const pdf = this.pdf;
    if (!pdf) return null;
    const region = regionOf(ref, settings);
    const box = this.boxSize();
    const dpr = window.devicePixelRatio || 1;
    const key = cacheKey(ref, region, box, dpr);

    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // LRU: 最近使ったものを末尾へ
      return hit;
    }

    const page = await pdf.getPage(ref.pdfPage);
    if (token !== null && token !== this.showToken) return null;

    const base = page.getViewport({ scale: 1 });
    const regionW = base.width * region.w;
    const regionH = base.height * region.h;
    let scale = Math.min(box.w / regionW, box.h / regionH) * dpr;
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (regionW * regionH)));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width * region.w));
    canvas.height = Math.max(1, Math.round(viewport.height * region.h));
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
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

    this.cache.set(key, canvas);
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return canvas;
  }
}

function cacheKey(ref: PageRef, r: NormRect, box: Box, dpr: number): string {
  return [ref.pdfPage, ref.side, r.x.toFixed(4), r.w.toFixed(4), box.w, box.h, dpr].join('|');
}
