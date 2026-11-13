import './style.css';
import { driveConfigured } from './config';
import { DriveAuth, type ConnectionState } from './drive/auth';
import { AuthExpiredError, downloadPdf } from './drive/download';
import { pickPdf } from './drive/picker';
import { buildPageList, clampIndex, findIndex, formatPageLabel, type LogicalPage } from './model/pages';
import { loadBookDocument, saveBookDocument } from './model/storage';
import { keyAction, tapAction } from './model/tap';
import type { BookSettings, BookSyncDocument } from './model/types';
import { PageViewer } from './reader/viewer';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return el as T;
};

const startEl = $('start');
const readerEl = $('reader');
const stageEl = $('stage');
const messageEl = $('message');
const progressEl = $('progress');
const progressBar = $('progress-bar');
const openDriveBtn = $<HTMLButtonElement>('open-drive');
const topbar = $('topbar');
const bottombar = $('bottombar');
const settingsEl = $('settings');
const pageLabel = $('page-label');

const auth = new DriveAuth();
const viewer = new PageViewer(stageEl);

/** 開いている本の状態 */
let doc: BookSyncDocument | null = null;
let pages: LogicalPage[] = [];
let index = 0;

// ---------- 接続状態(G-3: 切れても読書は止めない) ----------

const CONN_TEXT: Record<ConnectionState, string> = {
  disconnected: '未接続',
  connected: '接続中',
  expired: '接続が切れました(読書は続けられます)',
};

function renderConnection(state: ConnectionState): void {
  for (const id of ['conn-start', 'conn-reader']) {
    const el = $(id);
    el.textContent = CONN_TEXT[state];
    el.classList.toggle('expired', state === 'expired');
  }
  for (const id of ['reconnect-start', 'reconnect-reader']) $(id).hidden = state !== 'expired';
}
auth.onChange(renderConnection);
renderConnection(auth.state);

async function onReconnect(): Promise<void> {
  try {
    await auth.reconnect();
  } catch (e) {
    showMessage((e as Error).message, true);
  }
}
$('reconnect-start').addEventListener('click', () => void onReconnect());
$('reconnect-reader').addEventListener('click', () => void onReconnect());

// ---------- 開く ----------

function showMessage(text: string, isError = false): void {
  messageEl.textContent = text;
  messageEl.classList.toggle('error', isError);
}

function setProgress(fraction: number | null | 'off'): void {
  if (fraction === 'off') {
    progressEl.hidden = true;
    return;
  }
  progressEl.hidden = false;
  progressEl.classList.toggle('indeterminate', fraction === null);
  progressBar.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
}

async function openFromDrive(): Promise<void> {
  openDriveBtn.disabled = true;
  showMessage('');
  try {
    const token = await auth.ensureToken();
    const picked = await pickPdf(token);
    if (!picked) return;
    showMessage(`「${picked.name}」を取得しています…`);
    setProgress(null);
    let data: ArrayBuffer;
    try {
      data = await downloadPdf(picked.id, token, setProgress);
    } catch (e) {
      if (e instanceof AuthExpiredError) auth.expire();
      throw e;
    }
    await openBook(picked.id, picked.name, data);
  } catch (e) {
    showMessage((e as Error).message, true);
  } finally {
    setProgress('off');
    openDriveBtn.disabled = false;
  }
}

async function openLocal(file: File): Promise<void> {
  showMessage('');
  try {
    await openBook(`local:${file.name}:${file.size}`, file.name, await file.arrayBuffer());
  } catch (e) {
    showMessage((e as Error).message, true);
  }
}

async function openBook(bookId: string, name: string, data: ArrayBuffer): Promise<void> {
  // 先に画面を切り替えて、表示領域の大きさが確定してから描画する
  startEl.hidden = true;
  readerEl.hidden = false;
  try {
    await viewer.load(data);
  } catch (e) {
    closeBook();
    throw new Error(`PDFを開けませんでした: ${(e as Error).message}`);
  }
  doc = loadBookDocument(bookId);
  $('title').textContent = name;
  syncSettingsForm();
  pages = buildPageList(viewer.numPages, doc.settings);
  index = doc.position ? findIndex(pages, doc.position.page) : 0;
  setMenuVisible(false);
  await renderCurrent();
}

function closeBook(): void {
  void viewer.close();
  doc = null;
  pages = [];
  readerEl.hidden = true;
  startEl.hidden = false;
  settingsEl.hidden = true;
  setMenuVisible(false);
}

// ---------- 表示とページ送り ----------

async function renderCurrent(): Promise<void> {
  if (!doc || pages.length === 0) return;
  const settings = doc.settings;
  const page = pages[index];
  if (!page) return;
  pageLabel.textContent = `${formatPageLabel(index, settings)} / 全${pages.length}`;
  try {
    const shown = await viewer.show(page.ref, settings);
    if (shown) {
      const around = [pages[index + 1], pages[index - 1]].flatMap((p) => (p ? [p.ref] : []));
      void viewer.prefetch(around, settings);
    }
  } catch (e) {
    showMessage(`ページを表示できませんでした: ${(e as Error).message}`, true);
  }
}

function go(next: number): void {
  const target = clampIndex(pages, next);
  if (target === index) return;
  index = target;
  void renderCurrent();
}

function setMenuVisible(visible: boolean): void {
  topbar.hidden = !visible;
  bottombar.hidden = !visible;
  if (!visible) settingsEl.hidden = true;
}

// ---------- 操作: タップ / スワイプ / キー ----------

const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 500;
const SWIPE_MIN = 50;
let down: { x: number; y: number; t: number } | null = null;

stageEl.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
});

stageEl.addEventListener('pointerup', (e) => {
  const start = down;
  down = null;
  if (!start || !doc) return;
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  const dir = doc.settings.openDirection;

  if (Math.hypot(dx, dy) <= TAP_MAX_MOVE && performance.now() - start.t <= TAP_MAX_MS) {
    const action = tapAction(e.clientX / stageEl.clientWidth, dir);
    if (action === 'menu') setMenuVisible(Boolean(topbar.hidden));
    else go(action === 'next' ? index + 1 : index - 1);
    return;
  }
  if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
    // 右開き: 指を右へ送ると次(本をめくる向き)。左開きは逆。
    const next = dir === 'rtl' ? dx > 0 : dx < 0;
    go(next ? index + 1 : index - 1);
  }
});
stageEl.addEventListener('pointercancel', () => (down = null));

document.addEventListener('keydown', (e) => {
  if (!doc || readerEl.hidden) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'Escape') {
    setMenuVisible(false);
    return;
  }
  const action = keyAction(e.key, doc.settings.openDirection);
  if (!action) return;
  e.preventDefault();
  if (action === 'next') go(index + 1);
  else if (action === 'prev') go(index - 1);
  else if (action === 'first') go(0);
  else go(pages.length - 1);
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void renderCurrent(), 150);
});

// ---------- 本の設定(D-2, D-3, D-7) ----------

const dirSel = $<HTMLSelectElement>('set-direction');
const splitRange = $<HTMLInputElement>('set-split');
const splitOut = $('split-out');
const firstSel = $<HTMLSelectElement>('set-first');
const serialIn = $<HTMLInputElement>('set-serial');
const printedIn = $<HTMLInputElement>('set-printed');

function syncSettingsForm(): void {
  if (!doc) return;
  const s = doc.settings;
  dirSel.value = s.openDirection;
  splitRange.value = String(s.splitPosition);
  splitOut.textContent = `${(s.splitPosition * 100).toFixed(1)}%`;
  firstSel.value = s.firstPage;
  serialIn.value = s.printedNumber ? String(s.printedNumber.serial) : '';
  printedIn.value = s.printedNumber ? String(s.printedNumber.printed) : '';
}

/** 設定を1項目更新し、項目ごとの更新日時を記録して保存する(同期で「項目ごとに新しい方」を採るため)。 */
function updateSetting<K extends keyof BookSettings>(key: K, value: BookSettings[K]): void {
  if (!doc) return;
  doc.settings[key] = value;
  doc.settingsUpdatedAt[key] = Date.now();
  saveBookDocument(doc);
}

function rebuildPages(): void {
  if (!doc) return;
  const current = pages[index]?.ref;
  pages = buildPageList(viewer.numPages, doc.settings);
  index = current ? findIndex(pages, current) : 0;
  void renderCurrent();
}

dirSel.addEventListener('change', () => {
  updateSetting('openDirection', dirSel.value as BookSettings['openDirection']);
  rebuildPages();
});
splitRange.addEventListener('input', () => {
  const v = Number(splitRange.value);
  splitOut.textContent = `${(v * 100).toFixed(1)}%`;
  updateSetting('splitPosition', v);
  void renderCurrent();
});
firstSel.addEventListener('change', () => {
  updateSetting('firstPage', firstSel.value as BookSettings['firstPage']);
  rebuildPages();
});

function onPrintedChange(): void {
  const serial = parseInt(serialIn.value, 10);
  const printed = parseInt(printedIn.value, 10);
  if (Number.isFinite(serial) && serial >= 1 && Number.isFinite(printed)) {
    updateSetting('printedNumber', { serial, printed });
    void renderCurrent();
  }
}
serialIn.addEventListener('change', onPrintedChange);
printedIn.addEventListener('change', onPrintedChange);
$('clear-printed').addEventListener('click', () => {
  updateSetting('printedNumber', null);
  syncSettingsForm();
  void renderCurrent();
});

$('open-settings').addEventListener('click', () => (settingsEl.hidden = !settingsEl.hidden));
$('close-settings').addEventListener('click', () => (settingsEl.hidden = true));
$('back').addEventListener('click', closeBook);

// ---------- 起動 ----------

openDriveBtn.addEventListener('click', () => void openFromDrive());

if (!driveConfigured()) {
  openDriveBtn.disabled = true;
  showMessage('Google Cloud の設定(.env)が未設定です。docs/setup.md を参照してください。', true);
}

if (import.meta.env.DEV) {
  const localBtn = $<HTMLButtonElement>('open-local');
  const localInput = $<HTMLInputElement>('local-input');
  localBtn.hidden = false;
  localBtn.addEventListener('click', () => localInput.click());
  localInput.addEventListener('change', () => {
    const f = localInput.files?.[0];
    if (f) void openLocal(f);
  });
}
