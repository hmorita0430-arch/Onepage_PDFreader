import { DEFAULT_OUTPUT_FOLDER, ensureFolder, folderUrl, resolveOutputRoot, safeName, upsertFile, type ExportDestination } from '../drive/output';
import { COLORS, annotationBounds, groupByPage, numberMemos, type PageSize } from '../model/annotations';
import { groupAt } from '../model/layout';
import { chapterTitleAt, visibleNamed } from '../model/named';
import { findIndex, formatPageLabel, type LogicalPage } from '../model/pages';
import type { Annotation, BookSyncDocument, NormRect } from '../model/types';
import { buildMarkdown, type NoteItem, type NotePage } from './markdown';
import { drawAnnotations } from './draw';

/** 既定の書き出し先のフォルダ名(要件定義書 8章の決定: 2026-11-13)。設定で別のフォルダを選べる。 */
export const OUTPUT_FOLDER = DEFAULT_OUTPUT_FOLDER;
/** 画像の長辺(ピクセル)。スマホで読めて、容量が大きくなりすぎない大きさ */
const IMAGE_MAX_SIDE = 1800;

export interface ExportViewer {
  renderToCanvas(spec: { pdfPage: number; region: NormRect }, maxSide: number): Promise<{ canvas: HTMLCanvasElement; page: PageSize } | null>;
  textInRegions(pdfPage: number, regions: NormRect[]): Promise<(string | null)[]>;
}

export interface ExportInput {
  doc: BookSyncDocument;
  pages: LogicalPage[];
  /** 本の名前(ドライブ上のPDFのファイル名) */
  bookName: string;
  viewer: ExportViewer;
  token: string;
  onProgress?: (message: string) => void;
  /** 利用者が選んだ書き出し先。null/未指定なら、マイドライブ/読書ノート */
  destination?: ExportDestination | null;
  now?: Date;
  fetchFn?: typeof fetch;
}

export interface ExportResult {
  folderUrl: string;
  /** 保存した場所の表記(例: マイドライブ/読書ノート/本の名前) */
  locationLabel: string;
  pageCount: number;
  memoCount: number;
  highlightCount: number;
}

const pageNo = (index: number) => `page-${String(index + 1).padStart(3, '0')}.jpg`;

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), 'image/jpeg', 0.85));
}

/**
 * 読書ノートの書き出し(A-4, A-5)。注釈のあるページごとに、注釈を重ねた画像を作り、
 * Markdown(ページ番号+メモ内容+蛍光ペン箇所の文字)とともに、ドライブの通常フォルダへ保存する。
 *   マイドライブ/読書ノート/<本の名前>/読書ノート.md と images/page-NNN.jpg
 * 何度実行しても、同名のファイルは更新される(重複しない)。
 */
export async function exportNotes(input: ExportInput): Promise<ExportResult> {
  const { doc, pages, viewer, token } = input;
  const say = input.onProgress ?? (() => {});
  const groups = groupByPage(pages, doc.annotations);
  if (groups.size === 0) throw new Error('書き出せる注釈がありません(蛍光ペンやメモを付けてください)');

  const order = [...groups.keys()].sort((a, b) => a - b);
  // 目次(名前つきページ)があれば、章ごとにまとめる
  const chapters = visibleNamed(doc.namedPages, 'toc').map((n) => ({ title: n.title, index: findIndex(pages, n.page) }));
  const notePages: NotePage[] = [];
  const images: { name: string; blob: Blob }[] = [];
  let memoCount = 0;
  let highlightCount = 0;

  for (const [step, index] of order.entries()) {
    const annos = groups.get(index) as Annotation[];
    const shown = groupAt(pages, index, false, doc.settings);
    if (!shown) continue;
    say(`画像を作っています(${step + 1}/${order.length})`);

    const rendered = await viewer.renderToCanvas(shown.spec, IMAGE_MAX_SIDE);
    let imagePath: string | null = null;
    if (rendered) {
      drawAnnotations(rendered.canvas, annos, shown.spec.region, rendered.page);
      const name = pageNo(index);
      images.push({ name, blob: await canvasToBlob(rendered.canvas) });
      imagePath = `images/${name}`;
    }

    // 蛍光ペンの箇所の文字(OCRの文字データがあるときだけ)
    const highlights = annos.filter((a) => a.kind !== 'memo');
    const pageSize = rendered?.page ?? { w: 1, h: 1 };
    const texts = highlights.length
      ? await viewer.textInRegions(shown.spec.pdfPage, highlights.map((a) => clip(annotationBounds(a, pageSize))))
      : [];

    const nums = numberMemos(annos);
    let h = 0;
    const items: NoteItem[] = annos.map((a) => {
      if (a.kind === 'memo') {
        memoCount++;
        return { kind: 'memo', n: nums.get(a.id), text: a.text };
      }
      highlightCount++;
      return { kind: 'highlight', colorLabel: COLORS[a.color].label, ocr: texts[h++] ?? null };
    });
    notePages.push({
      label: formatPageLabel(index, doc.settings),
      imagePath,
      items,
      ...(chapters.length > 0 ? { chapter: chapterTitleAt(chapters, index) } : {}),
    });
  }

  const title = safeName(input.bookName.replace(/\.pdf$/i, ''));
  const markdown = buildMarkdown({ title, exportedAt: input.now ?? new Date(), pages: notePages });

  say('ドライブにフォルダを用意しています');
  const f = input.fetchFn ?? fetch;
  const root = await resolveOutputRoot(input.destination ?? null, token, f);
  const bookFolder = await ensureFolder(title, root, token, f);
  const imagesFolder = await ensureFolder('images', bookFolder, token, f);

  for (const [i, img] of images.entries()) {
    say(`画像を保存しています(${i + 1}/${images.length})`);
    await upsertFile(img.name, imagesFolder, img.blob, 'image/jpeg', token, f);
  }
  say('Markdownを保存しています');
  await upsertFile('読書ノート.md', bookFolder, new Blob([markdown], { type: 'text/markdown' }), 'text/markdown', token, f);

  const base = input.destination ? input.destination.name : `マイドライブ/${OUTPUT_FOLDER}`;
  return { folderUrl: folderUrl(bookFolder), locationLabel: `${base}/${title}`, pageCount: notePages.length, memoCount, highlightCount };
}

/**
 * 蛍光ペンの箇所の文字(OCRの文字データがあるときだけ)。注釈のIDごとに、文字または null(文字データなし)。
 * ページごとにまとめて取り出す。
 */
export async function highlightTexts(
  viewer: ExportViewer & { pageSize(pdfPage: number): Promise<PageSize> },
  annos: readonly Annotation[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const byPage = new Map<number, Annotation[]>();
  for (const a of annos) {
    if (a.kind === 'memo') continue;
    const arr = byPage.get(a.page.pdfPage);
    if (arr) arr.push(a);
    else byPage.set(a.page.pdfPage, [a]);
  }
  for (const [pdfPage, list] of byPage) {
    const size = await viewer.pageSize(pdfPage);
    const texts = await viewer.textInRegions(pdfPage, list.map((a) => clip(annotationBounds(a, size))));
    list.forEach((a, i) => out.set(a.id, texts[i] ?? null));
  }
  return out;
}

/** 文字の取り出し範囲を、元画像の内側に収める */
function clip(r: NormRect): NormRect {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(1, r.x + r.w);
  const y1 = Math.min(1, r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

