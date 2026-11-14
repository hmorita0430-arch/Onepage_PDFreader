/**
 * 読書ノート(Markdown)の生成。純粋関数。
 * 蛍光ペンの箇所の文字は、PDFにOCRの文字データがあるときだけ添える(要件定義書 8章の決定)。
 */
export interface NoteItem {
  kind: 'memo' | 'highlight';
  /** メモの番号(画像の番号と一致) */
  n?: number;
  /** 蛍光ペンの色の名前(例: 黄) */
  colorLabel?: string;
  /** メモの本文 */
  text?: string;
  /** 蛍光ペンの箇所の文字。null=文字データなし、undefined=添えない */
  ocr?: string | null;
}

export interface NotePage {
  /** 属する章(目次の名前)。目次が1つも無ければ undefined、最初の目次より前なら null */
  chapter?: string | null;
  /** 例: p.45(通し番号52) */
  label: string;
  /** Markdown からの相対パス。無ければ画像なし */
  imagePath: string | null;
  items: NoteItem[];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** リスト項目の中で改行しても、項目が崩れないようにする */
const indentLines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l, i) => (i === 0 ? l : `  ${l}`)).join('\n');

const two = (n: number) => String(n).padStart(2, '0');
export const formatDateTime = (d: Date): string =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;

export function buildMarkdown(p: { title: string; exportedAt: Date; pages: NotePage[] }): string {
  const memos = p.pages.reduce((n, pg) => n + pg.items.filter((i) => i.kind === 'memo').length, 0);
  const highlights = p.pages.reduce((n, pg) => n + pg.items.filter((i) => i.kind === 'highlight').length, 0);
  const anyOcr = p.pages.some((pg) => pg.items.some((i) => typeof i.ocr === 'string'));

  const out: string[] = [];
  out.push(`# ${oneLine(p.title)} 読書ノート`, '');
  out.push(`- 出力日時: ${formatDateTime(p.exportedAt)}`);
  out.push(`- メモ ${memos}件 / 蛍光ペン ${highlights}件`, '');

  // 目次(章)があれば、章を見出し(##)、ページを小見出し(###)にする
  const hasChapters = p.pages.some((pg) => pg.chapter !== undefined);
  let currentChapter: string | null | undefined;
  for (const pg of p.pages) {
    if (hasChapters && (currentChapter === undefined || pg.chapter !== currentChapter)) {
      currentChapter = pg.chapter ?? null;
      out.push(`## ${currentChapter === null ? '(章の前)' : oneLine(currentChapter)}`, '');
    }
    out.push(`${hasChapters ? '###' : '##'} ${pg.label}`, '');
    if (pg.imagePath) out.push(`![${pg.label}](${pg.imagePath})`, '');
    for (const it of pg.items) {
      if (it.kind === 'memo') {
        out.push(`- **メモ${it.n ?? ''}**: ${indentLines(it.text ?? '')}`);
      } else {
        const head = `- **蛍光ペン(${it.colorLabel ?? ''})**`;
        if (it.ocr === undefined) out.push(head);
        else if (it.ocr === null || oneLine(it.ocr) === '') out.push(`${head}: (文字データなし)`);
        else out.push(`${head}: 「${oneLine(it.ocr)}」`);
      }
    }
    out.push('');
  }

  if (anyOcr) {
    out.push('> 蛍光ペンの箇所の文字は、OCR(文字認識)で読み取ったもの、またはPDFの文字データから取り出したものです。誤認識を含む場合があります。', '');
  }
  return out.join('\n');
}
