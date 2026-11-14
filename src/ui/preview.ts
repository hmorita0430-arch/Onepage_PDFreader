import { COLORS } from '../model/annotations';
import type { ExportPackage } from '../export/exporter';
import { OCR_NOTE, type NoteItem } from '../export/markdown';

/**
 * 書き出しのプレビュー。書き出す内容(画像とMarkdownと同じ内容・順序)を、出来上がりの見た目で見せる。
 * 見るだけ。直したい箇所は、タップして注釈の一覧へ戻る。ドライブへの保存は「この内容で書き出す」を押したときだけ。
 */
export interface PreviewDeps {
  destinationLabel(): string;
  /** 内容をドライブへ保存する。失敗は例外(文言は利用者向け) */
  upload(pkg: ExportPackage, onProgress: (message: string) => void): Promise<{ message: string; url: string }>;
  /** プレビューを閉じて、注釈の一覧の該当の注釈へ戻る(id が無ければ、一覧だけ) */
  openAnnotation(id: string | null): void;
}

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} がありません`);
  return e as T;
};

const COLOR_BY_LABEL = new Map(Object.values(COLORS).map((c) => [c.label, c.css]));

export function createPreview(deps: PreviewDeps) {
  const root = el('export-preview');
  const summary = el('preview-summary');
  const body = el('preview-body');
  const dest = el('preview-dest');
  const status = el('preview-status');
  const link = el<HTMLAnchorElement>('preview-link');
  const exportBtn = el<HTMLButtonElement>('preview-export');
  const backBtn = el<HTMLButtonElement>('preview-back');
  const closeBtn = el<HTMLButtonElement>('preview-close');
  let pkg: ExportPackage | null = null;
  let urls: string[] = [];
  let busy = false;

  function render(p: ExportPackage): void {
    const parts = [`メモ ${p.memoCount}件 ・ 蛍光ペン ${p.highlightCount}件 ・ ${p.pageCount}ページ`];
    if (p.reading) parts.push(`読書の記録: ${p.reading}`);
    summary.textContent = `${p.title}\n${parts.join('\n')}`;

    const imageByName = new Map(p.images.map((i) => [i.name, i.blob]));
    const hasChapters = p.notePages.some((pg) => pg.chapter !== undefined);
    const nodes: HTMLElement[] = [];
    let currentChapter: string | null | undefined;
    for (const pg of p.notePages) {
      if (hasChapters && (currentChapter === undefined || pg.chapter !== currentChapter)) {
        currentChapter = pg.chapter ?? null;
        const h = document.createElement('h3');
        h.className = 'preview-chapter';
        h.textContent = currentChapter === null ? '(章の前)' : currentChapter; // 利用者の入力なので textContent
        nodes.push(h);
      }
      const sec = document.createElement('section');
      sec.className = 'preview-page';
      const title = document.createElement('button');
      title.type = 'button';
      title.className = 'preview-page-title';
      title.textContent = pg.label;
      title.setAttribute('aria-label', `${pg.label}の注釈を一覧で開く`);
      title.addEventListener('click', () => deps.openAnnotation(pg.items[0]?.id ?? null));
      sec.append(title);
      const name = pg.imagePath?.replace(/^images\//, '');
      const blob = name ? imageByName.get(name) : undefined;
      if (blob) {
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const img = document.createElement('img');
        img.className = 'preview-img';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = `${pg.label}(注釈つき)`;
        img.src = url;
        sec.append(img);
      }
      const ul = document.createElement('ul');
      ul.className = 'preview-items';
      for (const it of pg.items) ul.append(itemRow(it));
      sec.append(ul);
      nodes.push(sec);
    }
    if (p.notePages.some((pg) => pg.items.some((i) => typeof i.ocr === 'string'))) {
      const note = document.createElement('p');
      note.className = 'muted preview-note';
      note.textContent = OCR_NOTE;
      nodes.push(note);
    }
    body.replaceChildren(...nodes);
  }

  function itemRow(it: NoteItem): HTMLElement {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preview-item';
    const chip = document.createElement('span');
    chip.className = 'preview-chip';
    const text = document.createElement('span');
    text.className = 'preview-item-text';
    if (it.kind === 'memo') {
      chip.textContent = '✎';
      text.textContent = `メモ${it.n ?? ''}: ${it.text ?? ''}`;
    } else {
      chip.style.background = COLOR_BY_LABEL.get(it.colorLabel ?? '') ?? 'var(--muted)';
      const t = (it.ocr ?? '').replace(/\s+/g, ' ').trim();
      text.textContent = `蛍光ペン(${it.colorLabel ?? ''}): ${t === '' ? '(文字データなし)' : `「${t}」`}`;
    }
    b.append(chip, text);
    b.addEventListener('click', () => deps.openAnnotation(it.id ?? null));
    li.append(b);
    return li;
  }

  function open(p: ExportPackage): void {
    release();
    pkg = p;
    status.textContent = '';
    link.hidden = true;
    exportBtn.disabled = false;
    dest.textContent = deps.destinationLabel();
    render(p);
    root.hidden = false;
    root.querySelector('.preview-scroll')?.scrollTo({ top: 0 });
    exportBtn.focus();
  }

  /** 画像・内容を手放す */
  function release(): void {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    pkg = null;
    body.replaceChildren();
  }

  /** @returns 閉じたか(保存中は閉じない) */
  function close(): boolean {
    if (busy) return false;
    root.hidden = true;
    release();
    return true;
  }

  exportBtn.addEventListener('click', async () => {
    if (!pkg || busy) return;
    busy = true;
    exportBtn.disabled = true;
    backBtn.disabled = closeBtn.disabled = true;
    link.hidden = true;
    try {
      const r = await deps.upload(pkg, (m) => (status.textContent = m));
      status.textContent = r.message;
      link.href = r.url;
      link.hidden = false;
      backBtn.textContent = '閉じる';
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      busy = false;
      exportBtn.disabled = false;
      backBtn.disabled = closeBtn.disabled = false;
      exportBtn.textContent = 'もう一度書き出す';
    }
  });
  backBtn.addEventListener('click', () => void close());
  closeBtn.addEventListener('click', () => void close());

  return { open, close, isOpen: () => !root.hidden, isBusy: () => busy };
}
