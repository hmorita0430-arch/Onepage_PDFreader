import type { ViewSpec } from '../model/layout';
import { addNamedPage, deleteNamedPage, renameNamedPage, visibleNamed } from '../model/named';
import { findIndex, formatPageLabel, jumpTarget, type LogicalPage } from '../model/pages';
import type { BookSyncDocument, NamedPage } from '../model/types';

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
  /** 名前つきページを書き換えた。保存と同期の予約は呼ぶ側で行う */
  commit(): void;
}

type Tab = 'jump' | 'named' | 'thumbs';

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} がありません`);
  return e as T;
};

export function createNav(deps: NavDeps) {
  const root = el('nav');
  const panes: Record<Tab, HTMLElement> = { jump: el('nav-jump'), named: el('nav-named'), thumbs: el('nav-thumbs') };
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
    thumbGrid.replaceChildren();
  }

  el('nav-close').addEventListener('click', close);
  return { open, close, refresh, reset, isOpen: () => !root.hidden };
}
