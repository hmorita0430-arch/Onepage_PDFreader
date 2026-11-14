import { COLORS, COLOR_KEYS, deleteAnnotation, setAnnotationColor, setHighlightText, visibleAnnotations } from '../model/annotations';
import type { ViewSpec } from '../model/layout';
import { addNamedPage, chapterTitleAt, deleteNamedPage, renameNamedPage, visibleNamed } from '../model/named';
import { findIndex, formatPageLabel, jumpTarget, type LogicalPage } from '../model/pages';
import type { Annotation, AnnotationColor, BookSyncDocument, NamedPage } from '../model/types';
import type { OcrStatus } from '../ocr/ocr';
import type { Orientation } from '../ocr/text';

/**
 * ページ移動の画面: ページジャンプ(N-2)、しおり・目次(N-4)、サムネイル(N-3)。
 */
export interface NavDeps {
  getDoc(): BookSyncDocument | null;
  getPages(): LogicalPage[];
  getIndex(): number;
  /** 指定の論理ページへ移動する(画面を閉じるのは呼ぶ側ではなく Nav) */
  goTo(index: number): void;
  /** 1ページ表示のときの、トリミング後の描画範囲 */
  specFor(index: number): ViewSpec | null;
  thumbnail(spec: ViewSpec): Promise<string | null>;
  /** 名前つきページ・注釈を書き換えた。保存と同期の予約は呼ぶ側で行う */
  commit(): void;
  /** 既存のメモを入力欄で開く */
  editMemo(id: string): void;
  /** 蛍光ペンの箇所の文字(文字データが無ければ null) */
  ocrTexts(annos: Annotation[]): Promise<Map<string, string | null>>;
  /** 蛍光ペンの箇所を、端末内のOCRで読み取る(画像は端末の外へ送らない) */
  ocrRecognize(a: Annotation, orientation: Orientation, onStatus: (s: OcrStatus) => void): Promise<string>;
  /** 読み取りの書き方(縦書き/横書き)の既定。本の開き方向から決める */
  ocrOrientation(): Orientation;
  /** 読書ノートをドライブへ書き出す */
  exportNotes(onProgress: (message: string) => void): Promise<{ message: string; url: string }>;
  /** 書き出し先の説明(例: マイドライブ/読書ノート/本の名前/(既定)) */
  destinationLabel(): string;
  /** 書き出し先のフォルダを、ドライブ上で選び直す。結果・失敗は report で知らせる */
  chooseDestination(report: (message: string) => void): Promise<void>;
}

type Tab = 'jump' | 'named' | 'annos' | 'thumbs';

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} がありません`);
  return e as T;
};

export function createNav(deps: NavDeps) {
  const root = el('nav');
  const panes: Record<Tab, HTMLElement> = { jump: el('nav-jump'), named: el('nav-named'), annos: el('nav-annos'), thumbs: el('nav-thumbs') };
  const tabButtons = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  let tab: Tab = 'jump';

  // ---- タブ ----
  function selectTab(next: Tab): void {
    tab = next;
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === next));
    for (const [k, p] of Object.entries(panes)) p.hidden = k !== next;
    refresh();
  }
  for (const b of tabButtons) b.addEventListener('click', () => selectTab(b.dataset.tab as Tab));

  function jumpAndClose(index: number): void {
    close();
    deps.goTo(index);
  }

  // ---- ページジャンプ ----
  const jumpNow = el('jump-now');
  const jumpInput = el<HTMLInputElement>('jump-input');
  const jumpMode = el<HTMLSelectElement>('jump-mode');
  const jumpMsg = el('jump-msg');

  function renderJump(): void {
    const doc = deps.getDoc();
    const pages = deps.getPages();
    if (!doc) return;
    jumpNow.textContent = `いま: ${formatPageLabel(deps.getIndex(), doc.settings)} / 全${pages.length}ページ`;
    const printedOption = jumpMode.querySelector<HTMLOptionElement>('option[value="printed"]');
    if (printedOption) printedOption.disabled = !doc.settings.printedNumber;
    if (!doc.settings.printedNumber && jumpMode.value === 'printed') jumpMode.value = 'serial';
    jumpInput.max = String(pages.length);
  }

  function doJump(): void {
    const doc = deps.getDoc();
    if (!doc) return;
    const n = parseInt(jumpInput.value, 10);
    const target = jumpTarget(deps.getPages(), doc.settings, jumpMode.value as 'serial' | 'printed', n);
    if (target === null) {
      jumpMsg.textContent = Number.isFinite(n) ? 'そのページはありません' : '数字を入力してください';
      return;
    }
    jumpMsg.textContent = '';
    jumpAndClose(target);
  }
  el('jump-go').addEventListener('click', doJump);
  jumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJump();
  });

  // ---- しおり・目次 ----
  const namedKind = el<HTMLSelectElement>('named-kind');
  const namedTitle = el<HTMLInputElement>('named-title');
  const namedMsg = el('named-msg');

  function renderNamedList(listEl: HTMLElement, kind: NamedPage['kind'], emptyText: string): void {
    const doc = deps.getDoc();
    if (!doc) return;
    const pages = deps.getPages();
    const items = visibleNamed(doc.namedPages, kind)
      .map((n) => ({ n, index: findIndex(pages, n.page) }))
      .sort((a, b) => a.index - b.index || a.n.createdAt - b.n.createdAt);
    if (items.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = emptyText;
      listEl.replaceChildren(li);
      return;
    }
    listEl.replaceChildren(
      ...items.map(({ n, index }) => {
        const li = document.createElement('li');
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'named-go';
        const t = document.createElement('span');
        t.className = 'named-title';
        t.textContent = n.title; // 利用者の入力なので textContent で入れる
        const l = document.createElement('span');
        l.className = 'named-page';
        l.textContent = formatPageLabel(index, doc.settings);
        go.append(t, l);
        go.addEventListener('click', () => jumpAndClose(index));
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = '名前';
        edit.setAttribute('aria-label', `「${n.title}」の名前を変える`);
        edit.addEventListener('click', () => {
          const next = prompt('新しい名前', n.title);
          if (next === null || next.trim() === '') return;
          doc.namedPages = renameNamedPage(doc.namedPages, n.id, next.trim());
          deps.commit();
          refresh();
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = '削除';
        del.setAttribute('aria-label', `「${n.title}」を削除`);
        del.addEventListener('click', () => {
          if (!confirm(`「${n.title}」を削除しますか?`)) return;
          doc.namedPages = deleteNamedPage(doc.namedPages, n.id);
          deps.commit();
          refresh();
        });
        li.append(go, edit, del);
        return li;
      }),
    );
  }

  function renderNamed(): void {
    renderNamedList(el('named-bookmarks'), 'bookmark', 'しおりはまだありません');
    renderNamedList(el('named-toc'), 'toc', '目次はまだありません');
  }

  el('named-add').addEventListener('click', () => {
    const doc = deps.getDoc();
    const ref = deps.getPages()[deps.getIndex()]?.ref;
    if (!doc || !ref) return;
    const kind = namedKind.value as NamedPage['kind'];
    let title = namedTitle.value.trim();
    if (!title) {
      if (kind === 'toc') {
        namedMsg.textContent = '目次には名前(例: 第3章)を入力してください';
        return;
      }
      title = formatPageLabel(deps.getIndex(), doc.settings); // しおりは名前が無ければページ表記
    }
    doc.namedPages = addNamedPage(doc.namedPages, { kind, title, page: ref });
    namedTitle.value = '';
    namedMsg.textContent = `「${title}」を追加しました`;
    deps.commit();
    refresh();
  });

  // ---- 注釈の一覧(ページ順・検索・絞り込み・章ごと・編集・削除・書き出し) ----
  const annoQ = el<HTMLInputElement>('anno-q');
  const annoType = el<HTMLSelectElement>('anno-type');
  const annoColor = el<HTMLSelectElement>('anno-color');
  const annoGroup = el<HTMLInputElement>('anno-group');
  const annoCount = el('anno-count');
  const annoList = el('anno-list');
  const ocrCache = new Map<string, string | null>();
  let annoEpoch = 0;

  interface Row {
    a: Annotation;
    index: number;
  }

  function kindLabel(a: Annotation): string {
    return a.kind === 'memo' ? 'メモ' : a.kind === 'highlight-rect' ? '蛍光ペン(四角)' : '蛍光ペン(線)';
  }

  /** 行に出す文章: メモは本文、蛍光ペンは保存した文字(OCR・手直し)、なければPDFの文字データ */
  function rowText(a: Annotation): string {
    if (a.kind === 'memo') return a.text;
    if (a.ocrText) return a.ocrText;
    const t = ocrCache.get(a.id);
    return t ? t : '';
  }

  function matches(r: Row, q: string, type: string, color: string): boolean {
    const a = r.a;
    if (type === 'memo' && a.kind !== 'memo') return false;
    if (type === 'highlight' && a.kind === 'memo') return false;
    if (color !== 'all' && (a.kind === 'memo' || a.color !== color)) return false;
    if (q === '') return true;
    return rowText(a).toLowerCase().includes(q) || formatPageLabel(r.index, deps.getDoc()!.settings).toLowerCase().includes(q);
  }

  function renderAnnos(): void {
    const doc = deps.getDoc();
    if (!doc) return;
    const pages = deps.getPages();
    const all: Row[] = visibleAnnotations(doc.annotations)
      .map((a) => ({ a, index: findIndex(pages, a.page) }))
      .sort((x, y) => x.index - y.index || x.a.createdAt - y.a.createdAt);
    const q = annoQ.value.trim().toLowerCase();
    const rows = all.filter((r) => matches(r, q, annoType.value, annoColor.value));
    const memos = all.filter((r) => r.a.kind === 'memo').length;
    annoCount.textContent = `メモ ${memos}件・蛍光ペン ${all.length - memos}件` + (rows.length !== all.length ? `(表示 ${rows.length}件)` : '');

    const chapters = visibleNamed(doc.namedPages, 'toc').map((n) => ({ title: n.title, index: findIndex(pages, n.page) }));
    const grouped = annoGroup.checked && chapters.length > 0;
    const children: HTMLElement[] = [];
    let current: string | null | undefined;
    for (const r of rows) {
      if (grouped) {
        const ch = chapterTitleAt(chapters, r.index);
        if (current === undefined || ch !== current) {
          current = ch;
          const h = document.createElement('li');
          h.className = 'anno-chapter';
          h.textContent = ch === null ? '(章の前)' : ch; // 利用者の入力なので textContent
          children.push(h);
        }
      }
      children.push(annoRow(r, doc));
    }
    if (rows.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = all.length === 0 ? '注釈はまだありません。読書中に右クリック(PC)や長押し(スマホ)で付けられます。' : '条件に合う注釈がありません';
      children.push(li);
    }
    annoList.replaceChildren(...children);
    renderDest();
    void loadOcr(rows, q);
  }

  function annoRow(r: Row, doc: BookSyncDocument): HTMLElement {
    const a = r.a;
    const li = document.createElement('li');
    li.className = 'anno-row';
    li.dataset.id = a.id;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'anno-go';
    const chip = document.createElement('span');
    chip.className = 'anno-chip';
    if (a.kind === 'memo') chip.textContent = '✎';
    else chip.style.background = COLORS[a.color].css;
    const main = document.createElement('span');
    main.className = 'anno-main';
    const text = document.createElement('span');
    text.className = 'anno-text';
    text.textContent = rowText(a) || (a.kind === 'memo' ? '(空のメモ)' : kindLabel(a));
    const meta = document.createElement('span');
    meta.className = 'anno-page';
    meta.textContent = `${formatPageLabel(r.index, doc.settings)} ・ ${kindLabel(a)}`;
    main.append(text, meta);
    go.append(chip, main);
    go.addEventListener('click', () => jumpAndClose(r.index));
    li.append(go);

    if (a.kind === 'memo') {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '編集';
      edit.addEventListener('click', () => deps.editMemo(a.id));
      li.append(edit);
    } else {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', '色を変える');
      for (const c of COLOR_KEYS) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = COLORS[c].label;
        o.selected = c === a.color;
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        doc.annotations = setAnnotationColor(doc.annotations, a.id, sel.value as AnnotationColor);
        deps.commit();
        renderAnnos();
      });
      li.append(sel);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = '削除';
    del.setAttribute('aria-label', `${kindLabel(a)}を削除`);
    del.addEventListener('click', () => {
      if (!confirm('この注釈を削除しますか?')) return;
      doc.annotations = deleteAnnotation(doc.annotations, a.id);
      deps.commit();
      renderAnnos();
    });
    li.append(del);
    if (a.kind !== 'memo') li.append(ocrControls(a));
    return li;
  }

  // ---- 蛍光ペンの箇所の文字(OCR) ----
  let lastOrientation: Orientation | null = null;

  /** 行の下の「文字を取り出す」まわり。結果は注釈に保存し、手で直せる */
  function ocrControls(a: Exclude<Annotation, { kind: 'memo' }>): HTMLElement {
    const box = document.createElement('div');
    box.className = 'anno-ocr';
    const status = document.createElement('span');
    status.className = 'anno-ocr-status muted';
    status.setAttribute('role', 'status');

    const ori = document.createElement('select');
    ori.setAttribute('aria-label', '文字の書き方');
    for (const [v, label] of [['vertical', '縦書き'], ['horizontal', '横書き']] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      ori.append(o);
    }
    ori.value = lastOrientation ?? deps.ocrOrientation();
    ori.addEventListener('change', () => (lastOrientation = ori.value as Orientation));

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'anno-ocr-run';
    run.textContent = a.ocrText ? '読み取り直す' : '文字を取り出す';
    run.addEventListener('click', async () => {
      if (a.ocrText && !confirm('保存してある文字(手で直した分を含む)を、読み取り直した結果で置き換えます。よろしいですか?')) return;
      run.disabled = true;
      edit.disabled = true;
      status.textContent = '';
      try {
        const text = await deps.ocrRecognize(a, ori.value as Orientation, (s) => {
          status.textContent = s === 'loading' ? '準備しています(初めて使うときは、少し時間がかかります)…' : '読み取っています…';
        });
        if (text === '') {
          status.textContent = '文字を読み取れませんでした。書き方(縦書き/横書き)を変えて、もう一度試してください。';
          return;
        }
        const d = deps.getDoc();
        if (!d) return;
        d.annotations = setHighlightText(d.annotations, a.id, text);
        deps.commit();
        renderAnnos();
      } catch (e) {
        status.textContent = (e as Error).message || '読み取りに失敗しました';
      } finally {
        run.disabled = false;
        edit.disabled = false;
      }
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'anno-ocr-edit';
    edit.textContent = a.ocrText ? '文字を直す' : '文字を入力';
    edit.addEventListener('click', () => {
      const area = document.createElement('textarea');
      area.className = 'anno-ocr-area';
      area.rows = 3;
      area.value = a.ocrText ?? '';
      area.setAttribute('aria-label', '蛍光ペンの箇所の文字');
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = '保存';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'キャンセル';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'danger';
      clear.textContent = '文字を消す';
      const commitText = (t: string) => {
        const d = deps.getDoc();
        if (!d) return;
        d.annotations = setHighlightText(d.annotations, a.id, t);
        deps.commit();
        renderAnnos();
      };
      save.addEventListener('click', () => commitText(area.value));
      clear.addEventListener('click', () => commitText(''));
      cancel.addEventListener('click', () => renderAnnos());
      area.addEventListener('keydown', (e) => e.stopPropagation()); // 文字入力中は、ページ送りなどのキーに反応しない
      box.replaceChildren(area, save, cancel, ...(a.ocrText ? [clear] : []));
      area.focus();
    });

    box.append(ori, run, edit, status);
    return box;
  }

  /** 蛍光ペンの箇所の文字を、後から読み込んで行に反映する(文字データがあるPDFのみ) */
  async function loadOcr(rows: Row[], q: string): Promise<void> {
    const todo = rows.map((r) => r.a).filter((a) => a.kind !== 'memo' && !a.ocrText && !ocrCache.has(a.id));
    if (todo.length === 0) return;
    const my = ++annoEpoch;
    const texts = await deps.ocrTexts(todo).catch(() => new Map<string, string | null>());
    if (my !== annoEpoch) return;
    for (const a of todo) ocrCache.set(a.id, texts.get(a.id) ?? null);
    if (root.hidden || tab !== 'annos') return;
    if (q !== '') {
      renderAnnos(); // 検索中は、読み込んだ文字も検索の対象にして並べ直す
      return;
    }
    for (const a of todo) {
      const t = ocrCache.get(a.id);
      const node = annoList.querySelector(`li[data-id="${CSS.escape(a.id)}"] .anno-text`);
      if (node && t) node.textContent = t;
    }
  }

  for (const c of [annoQ, annoType, annoColor, annoGroup]) c.addEventListener('input', renderAnnos);

  const annoDest = el('anno-export-dest');
  const renderDest = () => (annoDest.textContent = deps.destinationLabel());
  el('anno-dest-pick').addEventListener('click', () => {
    annoExportLink.hidden = true;
    void deps.chooseDestination((m) => (annoExportStatus.textContent = m)).then(renderDest, (e: Error) => (annoExportStatus.textContent = e.message));
  });
  const annoExportBtn = el<HTMLButtonElement>('anno-export');
  const annoExportStatus = el('anno-export-status');
  const annoExportLink = el<HTMLAnchorElement>('anno-export-link');
  annoExportBtn.addEventListener('click', async () => {
    annoExportLink.hidden = true;
    annoExportBtn.disabled = true;
    try {
      const r = await deps.exportNotes((m) => (annoExportStatus.textContent = m));
      annoExportStatus.textContent = r.message;
      annoExportLink.href = r.url;
      annoExportLink.hidden = false;
    } catch (e) {
      annoExportStatus.textContent = (e as Error).message;
    } finally {
      annoExportBtn.disabled = false;
    }
  });

  // ---- サムネイル ----
  const thumbGrid = el('thumb-grid');
  const urls = new Map<string, string>();
  let observer: IntersectionObserver | undefined;
  const queue: HTMLElement[] = [];
  let pumping = false;
  let epoch = 0;

  const keyOf = (spec: ViewSpec) =>
    [spec.pdfPage, spec.region.x, spec.region.y, spec.region.w, spec.region.h].map((v) => +v.toFixed(4)).join('|');

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    const my = epoch;
    try {
      while (queue.length > 0 && my === epoch) {
        const item = queue.shift()!;
        const index = Number(item.dataset.index);
        const spec = deps.specFor(index);
        const img = item.querySelector('img');
        if (!spec || !img || !item.isConnected) continue;
        const key = keyOf(spec);
        let url = urls.get(key);
        if (!url) {
          const made = await deps.thumbnail(spec).catch(() => null);
          if (my !== epoch) {
            if (made) URL.revokeObjectURL(made);
            return;
          }
          if (made) urls.set(key, (url = made));
        }
        if (url) {
          img.src = url;
          item.classList.add('loaded');
        }
      }
    } finally {
      pumping = false;
    }
  }

  function renderThumbs(): void {
    const doc = deps.getDoc();
    const pages = deps.getPages();
    if (!doc) return;
    epoch++;
    queue.length = 0;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          observer?.unobserve(e.target);
          queue.push(e.target as HTMLElement);
        }
        void pump();
      },
      { root: panes.thumbs, rootMargin: '300px' },
    );
    const current = deps.getIndex();
    const items = pages.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb';
      b.dataset.index = String(p.index);
      if (p.index === current) b.classList.add('current');
      const img = document.createElement('img');
      img.alt = '';
      const spec = deps.specFor(p.index);
      const cached = spec ? urls.get(keyOf(spec)) : undefined;
      if (cached) {
        img.src = cached;
        b.classList.add('loaded');
      }
      const cap = document.createElement('span');
      const { serial, printed } = { serial: p.index + 1, printed: doc.settings.printedNumber ? p.index + 1 - doc.settings.printedNumber.serial + doc.settings.printedNumber.printed : null };
      cap.textContent = printed !== null && printed >= 1 ? `p.${printed}` : String(serial);
      b.append(img, cap);
      b.setAttribute('aria-label', `${formatPageLabel(p.index, doc.settings)}へ移動`);
      b.addEventListener('click', () => jumpAndClose(p.index));
      if (!cached) observer?.observe(b);
      return b;
    });
    thumbGrid.replaceChildren(...items);
    thumbGrid.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }

  // ---- 全体 ----
  function refresh(): void {
    if (root.hidden) return;
    if (tab === 'jump') renderJump();
    else if (tab === 'named') renderNamed();
    else if (tab === 'annos') renderAnnos();
    else renderThumbs();
  }

  function open(next: Tab = 'jump'): void {
    root.hidden = false;
    jumpMsg.textContent = '';
    namedMsg.textContent = '';
    selectTab(next);
    if (next === 'jump') jumpInput.focus();
  }

  function close(): void {
    root.hidden = true;
    epoch++;
    queue.length = 0;
    observer?.disconnect();
  }

  /** 本を閉じたとき: サムネイルの画像を手放す */
  function reset(): void {
    close();
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
    ocrCache.clear();
    annoEpoch++;
    thumbGrid.replaceChildren();
  }

  el('nav-close').addEventListener('click', close);
  return { open, close, refresh, reset, isOpen: () => !root.hidden };
}
