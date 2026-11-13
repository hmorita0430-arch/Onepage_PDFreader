import './style.css';
import { driveConfigured } from './config';
import { DriveAuth, type ConnectionState } from './drive/auth';
import { AuthExpiredError, downloadResumable, fetchFileInfo } from './drive/download';
import { pickPdf } from './drive/picker';
import {
  effectiveCrop,
  isFullRect,
  marginsToRect,
  mirrorRect,
  pageCropKey,
  rectToMargins,
  type Margins,
} from './model/crop';
import { formatShownLabel, groupAt, nextIndex, normalizeIndex, prevIndex, type Shown } from './model/layout';
import { buildPageList, clampIndex, findIndex, regionOf, type LogicalPage } from './model/pages';
import { loadBase, loadBookDocument, saveBase, saveBookDocument } from './model/storage';
import { keyAction, tapAction } from './model/tap';
import type { BookSettings, BookSyncDocument, PageOverride } from './model/types';
import {
  deleteBook,
  getBlob,
  getMeta,
  listBooks,
  requestPersistence,
  saveBook,
  storageInfo,
  touchBook,
} from './offline/library';
import { countUnsynced, mergeDocuments } from './sync/merge';
import { isSyncable, syncBook } from './sync/remote';
import { createNav } from './ui/nav';
import { attachGestures } from './reader/gestures';
import { PageViewer } from './reader/viewer';
import {
  clampState,
  DOUBLE_TAP_Z,
  isZoomed,
  layout,
  panBy,
  RESET_VIEW,
  zoomAt,
  type Size,
  type ViewState,
} from './reader/view';

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
const cropPanel = $('crop-panel');

const auth = new DriveAuth();
const viewer = new PageViewer(stageEl);

/** 開いている本の状態 */
let doc: BookSyncDocument | null = null;
let pages: LogicalPage[] = [];
let index = 0;
let view: ViewState = { ...RESET_VIEW };
let fit: Size = { w: 1, h: 1 };
let cropping = false;
/** 前回の同期で確定した内容。未同期の件数を求める基準 */
let base: BookSyncDocument | null = null;
let syncing = false;
let syncAgain = false;
let syncError: string | null = null;
let syncTimer: ReturnType<typeof setTimeout> | undefined;

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
auth.onChange((state) => {
  renderSyncStatus();
  if (state === 'connected') void syncNow(); // 再接続したら、保留していた同期を再開する
});
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
    if (!navigator.onLine) throw new Error('オフラインです。「端末に保存した本」から開いてください');
    const token = await auth.ensureToken();
    const picked = await pickPdf(token);
    if (!picked) return;

    setProgress(null);
    let info;
    try {
      info = await fetchFileInfo(picked.id, token);
    } catch (e) {
      if (e instanceof AuthExpiredError) auth.expire();
      throw e;
    }

    // 保存済みで、ドライブ上の版が同じなら、取得し直さず保存済みの本を使う
    const saved = await getMeta(picked.id).catch(() => undefined);
    let blob = saved && info.md5 && saved.md5 === info.md5 ? await getBlob(picked.id).catch(() => undefined) : undefined;

    if (!blob) {
      showMessage(`「${info.name}」を取得しています…`);
      try {
        blob = await downloadResumable(picked.id, token, info, setProgress);
      } catch (e) {
        if (e instanceof AuthExpiredError) {
          auth.expire();
          throw new Error('接続が切れました。「再接続」を押してから、もう一度同じ本を選んでください(取得済みの分は続きから再開します)');
        }
        throw e;
      }
      await saveToDevice(picked.id, info.name, info.md5, blob);
    }
    await openBook(picked.id, info.name, await blob.arrayBuffer());
  } catch (e) {
    showMessage((e as Error).message, true);
  } finally {
    setProgress('off');
    openDriveBtn.disabled = false;
    void refreshLibrary();
  }
}

/** 端末に自動保存する(G-4)。保存できなくても、この回は読める。 */
async function saveToDevice(bookId: string, name: string, md5: string | null, blob: Blob): Promise<void> {
  try {
    await saveBook({ bookId, name, size: blob.size, md5 }, blob);
    await requestPersistence();
  } catch {
    showMessage('端末に保存できませんでした(空き容量が足りない可能性があります)。今回は読めますが、次回は取得し直しになります', true);
  }
}

async function openSaved(bookId: string): Promise<void> {
  showMessage('');
  try {
    const [meta, blob] = await Promise.all([getMeta(bookId), getBlob(bookId)]);
    if (!meta || !blob) throw new Error('保存した本が見つかりません');
    await touchBook(bookId);
    await openBook(bookId, meta.name, await blob.arrayBuffer());
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
  base = loadBase(bookId);
  syncError = null;
  $('title').textContent = name;
  // 接続中なら、描画の前に同期して、他端末の最後に読んだ位置・設定・しおりを反映する(G-2)。
  // 通信が遅くても開くのを待たせない(5秒で打ち切り、同期はそのまま続ける)
  if (isSyncable(bookId) && auth.currentToken()) {
    await Promise.race([syncNow(), new Promise<void>((r) => setTimeout(r, 5000))]);
  }
  renderSyncStatus();
  syncSettingsForm();
  pages = buildPageList(viewer.numPages, doc.settings);
  index = doc.position ? findIndex(pages, doc.position.page) : 0; // N-1: 最後に読んだ位置から開く
  view = { ...RESET_VIEW };
  setMenuVisible(false);
  await renderCurrent();
}

function closeBook(): void {
  flushPosition();
  void syncNow(); // 閉じる前の変更を、接続中なら送る
  nav.reset();
  if (cropping) exitCrop(false);
  void viewer.close();
  doc = null;
  base = null;
  clearTimeout(syncTimer);
  pages = [];
  readerEl.hidden = true;
  startEl.hidden = false;
  settingsEl.hidden = true;
  setMenuVisible(false);
  void refreshLibrary();
}

// ---------- 表示 ----------

const hostBox = (): Size => viewer.box;

/** 横長画面で「2ページ」を選んでいるときだけ、見開きのまま表示する(D-6) */
function isDouble(): boolean {
  return !!doc && !cropping && doc.settings.landscapeLayout === 'double' && stageEl.clientWidth > stageEl.clientHeight;
}

/** 余白の設定中は、トリミング前の1ページを表示する */
function currentShown(): Shown | null {
  if (!doc) return null;
  const page = pages[index];
  if (!page) return null;
  if (cropping) return { indices: [index], spec: { pdfPage: page.ref.pdfPage, region: regionOf(page.ref, doc.settings) } };
  return groupAt(pages, index, isDouble(), doc.settings);
}

function applyView(): void {
  view = clampState(hostBox(), fit, view);
  const l = layout(hostBox(), fit, view);
  viewer.setTransform(l.tx, l.ty, l.scale);
}

async function renderCurrent(): Promise<void> {
  if (!doc || pages.length === 0) return;
  const settings = doc.settings;
  index = normalizeIndex(pages, clampIndex(pages, index), isDouble());
  const shown = currentShown();
  if (!shown) return;
  pageLabel.textContent = `${formatShownLabel(shown.indices, settings)} / 全${pages.length}`;
  try {
    const result = await viewer.show(shown.spec);
    if (!result) return;
    fit = result;
    applyView();
    updateCropOverlay();
    if (!cropping) {
      const double = isDouble();
      const around = [nextIndex(pages, index, double), prevIndex(pages, index, double)]
        .filter((i) => i !== index)
        .flatMap((i) => {
          const g = groupAt(pages, i, double, settings);
          return g ? [g.spec] : [];
        });
      void viewer.prefetch(around);
      schedulePositionSave();
    }
  } catch (e) {
    showMessage(`ページを表示できませんでした: ${(e as Error).message}`, true);
  }
}

function go(target: number): void {
  if (!doc) return;
  const next = normalizeIndex(pages, clampIndex(pages, target), isDouble());
  if (next === index) return;
  index = next;
  // ズーム維持でなければ、ページを送るたびにフィット表示へ戻る(D-9)
  if (!doc.settings.zoomKeep) view = { ...RESET_VIEW };
  void renderCurrent();
}

const goNext = () => go(nextIndex(pages, index, isDouble()));
const goPrev = () => go(prevIndex(pages, index, isDouble()));

function setMenuVisible(visible: boolean): void {
  topbar.hidden = !visible;
  bottombar.hidden = !visible;
  if (!visible) settingsEl.hidden = true;
}

// ---------- 最後に読んだ位置(N-1) ----------

let positionTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePositionSave(): void {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(flushPosition, 400);
}

function flushPosition(): void {
  clearTimeout(positionTimer);
  const page = pages[index];
  if (!doc || !page || cropping) return;
  doc.position = { page: page.ref, updatedAt: Date.now() };
  saveBookDocument(doc);
  markDirty();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushPosition();
    void syncNow();
  }
});
window.addEventListener('pagehide', flushPosition);

// ---------- 同期(G-2, G-3) ----------

const syncBadge = $('sync-badge');
const syncText = $('sync-status-text');

function unsyncedCount(): number {
  return doc && isSyncable(doc.bookId) ? countUnsynced(doc, base) : 0;
}

/** 未同期の件数と、同期の状態を常に表示する(G-3) */
function renderSyncStatus(): void {
  if (!doc || !isSyncable(doc.bookId)) {
    syncBadge.hidden = true;
    syncText.textContent = '開発用に開いた本は同期しません';
    return;
  }
  syncBadge.hidden = false;
  const n = unsyncedCount();
  const connected = auth.state === 'connected';
  let text = syncing ? '同期中…' : n === 0 ? '同期済み' : `未同期 ${n}件`;
  if (!syncing && n > 0 && !connected) text += '(接続待ち)';
  if (syncError) text += ` ・ ${syncError}`;
  syncBadge.textContent = text;
  syncBadge.classList.toggle('pending', !syncing && n > 0);
  syncBadge.classList.toggle('error', Boolean(syncError));
  syncText.textContent = `${text}。${connected ? '接続中です。' : '接続が切れています。「今すぐ同期」で再接続できます。'}`;
}

/** 変更があった。表示を更新し、接続中なら少し待ってから同期する */
function markDirty(): void {
  renderSyncStatus();
  scheduleSync(5000);
}

function scheduleSync(delayMs: number): void {
  clearTimeout(syncTimer);
  if (!doc || !isSyncable(doc.bookId)) return;
  syncTimer = setTimeout(() => void syncNow(), delayMs);
}

/** 同期の結果を取り込む。同期中に手元で変えた分も、統合し直して取りこぼさない。 */
function applyMerged(bookId: string, result: BookSyncDocument): void {
  const local = doc && doc.bookId === bookId ? doc : loadBookDocument(bookId);
  const settingsBefore = JSON.stringify(local.settings);
  const merged = mergeDocuments(local, result);
  saveBookDocument(merged);
  saveBase(result);
  if (!doc || doc.bookId !== bookId) return;
  doc = merged;
  base = result;
  if (JSON.stringify(doc.settings) !== settingsBefore) {
    syncSettingsForm();
    if (pages.length > 0) rebuildPages();
  }
  nav.refresh();
}

async function syncNow(): Promise<void> {
  if (!doc || !isSyncable(doc.bookId)) return;
  const token = auth.currentToken();
  if (!token) {
    renderSyncStatus(); // 接続が切れている間は保留し、件数を表示し続ける
    return;
  }
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  syncError = null;
  renderSyncStatus();
  const bookId = doc.bookId;
  try {
    const result = await syncBook(doc, token);
    applyMerged(bookId, result.merged);
  } catch (e) {
    if (e instanceof AuthExpiredError) auth.expire();
    else syncError = '通信エラーで同期できませんでした';
  } finally {
    syncing = false;
    renderSyncStatus();
    // 同期中に増えた変更があれば、もう一度(エラー時は無限に繰り返さない)
    if (!syncError && auth.currentToken() && (syncAgain || unsyncedCount() > 0)) scheduleSync(syncAgain ? 500 : 5000);
    syncAgain = false;
  }
}

// ---------- ページ移動・しおり・サムネイル(N-2, N-3, N-4) ----------

const nav = createNav({
  getDoc: () => doc,
  getPages: () => pages,
  getIndex: () => index,
  goTo: (i) => {
    setMenuVisible(false);
    go(i);
  },
  specFor: (i) => (doc ? (groupAt(pages, i, false, doc.settings)?.spec ?? null) : null),
  thumbnail: (spec) => viewer.renderThumbnail(spec, 200, 280),
  commit: () => {
    if (!doc) return;
    saveBookDocument(doc);
    markDirty();
  },
});

// ---------- 操作: タップ / スワイプ / ピンチ / ホイール / キー ----------

attachGestures(stageEl, {
  isZoomed: () => isZoomed(view),
  isCenter: (xf) => !doc || tapAction(xf, doc.settings.openDirection) === 'menu',
  onEdgeTap: (xf) => {
    if (!doc) return;
    const action = tapAction(xf, doc.settings.openDirection);
    if (action === 'next') goNext();
    else if (action === 'prev') goPrev();
  },
  onCenterTap: () => {
    if (doc && !cropping) setMenuVisible(Boolean(topbar.hidden));
  },
  onDoubleTap: (x, y) => {
    if (!doc) return;
    view = zoomAt(hostBox(), fit, view, isZoomed(view) ? 1 : DOUBLE_TAP_Z, x, y);
    applyView();
  },
  onSwipe: (dx) => {
    if (!doc) return;
    // 右開き: 指を右へ送ると次(本をめくる向き)。左開きは逆。
    const next = doc.settings.openDirection === 'rtl' ? dx > 0 : dx < 0;
    if (next) goNext();
    else goPrev();
  },
  onPan: (dx, dy) => {
    if (!doc) return;
    view = panBy(hostBox(), fit, view, dx, dy);
    applyView();
  },
  onZoom: (factor, x, y) => {
    if (!doc) return;
    view = zoomAt(hostBox(), fit, view, view.z * factor, x, y);
    applyView();
  },
});

document.addEventListener('keydown', (e) => {
  if (!doc || readerEl.hidden) return;
  if (nav.isOpen()) {
    if (e.key === 'Escape') nav.close();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'Escape') {
    if (cropping) exitCrop(true);
    else setMenuVisible(false);
    return;
  }
  // ズーム: + / - / 0(フィットに戻す)
  if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') {
    e.preventDefault();
    const box = hostBox();
    const z = e.key === '0' ? 1 : e.key === '-' ? view.z / 1.25 : view.z * 1.25;
    view = zoomAt(box, fit, view, z, box.w / 2, box.h / 2);
    applyView();
    return;
  }
  const action = keyAction(e.key, doc.settings.openDirection);
  if (!action) return;
  e.preventDefault();
  if (action === 'next') goNext();
  else if (action === 'prev') goPrev();
  else if (action === 'first') go(0);
  else go(pages.length - 1);
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void renderCurrent(), 150);
});

// ---------- 本の設定(D-2, D-3, D-6, D-7, D-9) ----------

const dirSel = $<HTMLSelectElement>('set-direction');
const splitRange = $<HTMLInputElement>('set-split');
const splitOut = $('split-out');
const firstSel = $<HTMLSelectElement>('set-first');
const layoutSel = $<HTMLSelectElement>('set-layout');
const zoomKeepChk = $<HTMLInputElement>('set-zoomkeep');
const serialIn = $<HTMLInputElement>('set-serial');
const printedIn = $<HTMLInputElement>('set-printed');

function syncSettingsForm(): void {
  if (!doc) return;
  const s = doc.settings;
  dirSel.value = s.openDirection;
  splitRange.value = String(s.splitPosition);
  splitOut.textContent = `${(s.splitPosition * 100).toFixed(1)}%`;
  firstSel.value = s.firstPage;
  layoutSel.value = s.landscapeLayout;
  zoomKeepChk.checked = s.zoomKeep;
  serialIn.value = s.printedNumber ? String(s.printedNumber.serial) : '';
  printedIn.value = s.printedNumber ? String(s.printedNumber.printed) : '';
}

/** 設定を1項目更新し、項目ごとの更新日時を記録して保存する(同期で「項目ごとに新しい方」を採るため)。 */
function updateSetting<K extends keyof BookSettings>(key: K, value: BookSettings[K]): void {
  if (!doc) return;
  doc.settings[key] = value;
  doc.settingsUpdatedAt[key] = Date.now();
  saveBookDocument(doc);
  markDirty();
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
layoutSel.addEventListener('change', () => {
  updateSetting('landscapeLayout', layoutSel.value as BookSettings['landscapeLayout']);
  view = { ...RESET_VIEW };
  void renderCurrent();
});
zoomKeepChk.addEventListener('change', () => {
  updateSetting('zoomKeep', zoomKeepChk.checked);
  if (!zoomKeepChk.checked) {
    view = { ...RESET_VIEW };
    applyView();
  }
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
$('open-nav').addEventListener('click', () => {
  setMenuVisible(false);
  nav.open('jump');
});
$('sync-now').addEventListener('click', () => {
  if (!auth.currentToken()) void onReconnect();
  else void syncNow();
});
$('close-settings').addEventListener('click', () => (settingsEl.hidden = true));
$('back').addEventListener('click', closeBook);

// ---------- 余白の設定(D-5) ----------

type Side4 = keyof Margins;
const SIDES: Side4[] = ['top', 'right', 'bottom', 'left'];
const cropInput = (s: Side4) => $<HTMLInputElement>(`crop-${s}`);
const cropOut = (s: Side4) => $(`crop-${s}-out`);
const cropMsg = $('crop-msg');

const cropOverlay = document.createElement('div');
cropOverlay.className = 'crop-overlay';
cropOverlay.hidden = true;
const shades = {
  top: document.createElement('div'),
  bottom: document.createElement('div'),
  left: document.createElement('div'),
  right: document.createElement('div'),
};
const cropFrameEl = document.createElement('div');
cropFrameEl.className = 'frame';
for (const el of Object.values(shades)) el.className = 'shade';
cropOverlay.append(...Object.values(shades), cropFrameEl);
viewer.pageEl.append(cropOverlay);

function readMargins(): Margins {
  return {
    top: Number(cropInput('top').value),
    right: Number(cropInput('right').value),
    bottom: Number(cropInput('bottom').value),
    left: Number(cropInput('left').value),
  };
}

function setMargins(m: Margins): void {
  for (const s of SIDES) cropInput(s).value = String(Math.round(m[s] * 1000) / 1000);
  updateCropOverlay();
}

function updateCropOverlay(): void {
  cropOverlay.hidden = !cropping;
  if (!cropping) return;
  const m = readMargins();
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  for (const s of SIDES) cropOut(s).textContent = `${(m[s] * 100).toFixed(1)}%`;
  Object.assign(shades.top.style, { left: '0', right: '0', top: '0', height: pct(m.top) });
  Object.assign(shades.bottom.style, { left: '0', right: '0', bottom: '0', height: pct(m.bottom) });
  Object.assign(shades.left.style, { left: '0', width: pct(m.left), top: pct(m.top), bottom: pct(m.bottom) });
  Object.assign(shades.right.style, { right: '0', width: pct(m.right), top: pct(m.top), bottom: pct(m.bottom) });
  Object.assign(cropFrameEl.style, { left: pct(m.left), right: pct(m.right), top: pct(m.top), bottom: pct(m.bottom) });
}

async function enterCrop(): Promise<void> {
  const page = pages[index];
  if (!doc || !page) return;
  settingsEl.hidden = true;
  setMenuVisible(false);
  cropping = true;
  cropMsg.textContent = '';
  readerEl.classList.add('cropping');
  cropPanel.hidden = false;
  readerEl.style.setProperty('--panel-h', `${cropPanel.offsetHeight}px`);
  setMargins(rectToMargins(effectiveCrop(page.ref, doc.settings)));
  view = { ...RESET_VIEW };
  await renderCurrent();
}

function exitCrop(rerender: boolean): void {
  cropping = false;
  readerEl.classList.remove('cropping');
  cropPanel.hidden = true;
  readerEl.style.removeProperty('--panel-h');
  cropOverlay.hidden = true;
  if (rerender) {
    view = { ...RESET_VIEW };
    void renderCurrent();
  }
}

function currentCropRect() {
  return marginsToRect(readMargins());
}

function saveCropFrame(): void {
  const page = pages[index];
  if (!doc || !page) return;
  const rect = currentCropRect();
  if (isFullRect(rect)) {
    updateSetting('cropFrame', null);
    cropMsg.textContent = '余白を削らない設定(共通枠なし)にしました';
    return;
  }
  // 共通枠は右ページ基準で持つ。左ページで設定したときは左右を反転して保存する
  updateSetting('cropFrame', page.ref.side === 'L' ? mirrorRect(rect) : rect);
  cropMsg.textContent = 'この本の共通枠として保存しました(左ページには左右反転で適用されます)';
}

function updatePageOverride(fn: (cur: PageOverride) => PageOverride | null): void {
  const page = pages[index];
  if (!doc || !page) return;
  const key = pageCropKey(page.ref);
  const all = { ...doc.settings.pageOverrides };
  const next = fn(all[key] ?? {});
  if (next && Object.keys(next).length > 0) all[key] = next;
  else delete all[key];
  updateSetting('pageOverrides', all);
}

$('open-crop').addEventListener('click', () => void enterCrop());
for (const s of SIDES) cropInput(s).addEventListener('input', updateCropOverlay);
$('crop-save-frame').addEventListener('click', saveCropFrame);
$('crop-save-page').addEventListener('click', () => {
  updatePageOverride((cur) => ({ ...cur, crop: currentCropRect() }));
  cropMsg.textContent = 'このページだけに適用しました';
});
$('crop-clear-page').addEventListener('click', () => {
  updatePageOverride((cur) => {
    const { crop: _removed, ...rest } = cur;
    return rest;
  });
  const page = pages[index];
  if (doc && page) setMargins(rectToMargins(effectiveCrop(page.ref, doc.settings)));
  cropMsg.textContent = 'このページの個別設定を消しました(共通枠に戻ります)';
});
$('crop-clear-frame').addEventListener('click', () => {
  updateSetting('cropFrame', null);
  const page = pages[index];
  if (doc && page) setMargins(rectToMargins(effectiveCrop(page.ref, doc.settings)));
  cropMsg.textContent = '共通枠を消しました';
});
$('crop-done').addEventListener('click', () => exitCrop(true));

// ---------- 端末に保存した本(G-4) ----------

const MB = 1024 * 1024;
const fmtSize = (bytes: number) => (bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1)} GB` : `${(bytes / MB).toFixed(1)} MB`);
const fmtDate = (t: number) => new Date(t).toLocaleDateString('ja-JP');

async function refreshLibrary(): Promise<void> {
  const list = $('library-list');
  const empty = $('library-empty');
  const info = $('storage-info');
  let books;
  try {
    books = await listBooks();
  } catch {
    list.replaceChildren();
    empty.textContent = '端末内の保存領域を利用できません(ブラウザの設定やプライベートモードを確認してください)';
    empty.hidden = false;
    return;
  }
  list.replaceChildren(
    ...books.map((b) => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.className = 'info';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = b.name; // ファイル名は利用者データなので textContent で入れる
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${fmtSize(b.size)} ・ 最後に開いた日: ${fmtDate(b.lastOpenedAt)}`;
      text.append(name, sub);
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = '開く';
      open.addEventListener('click', () => void openSaved(b.bookId));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = '削除';
      del.setAttribute('aria-label', `「${b.name}」を端末から削除`);
      del.addEventListener('click', async () => {
        if (!confirm(`「${b.name}」を端末から削除しますか?\n(しおり・設定などは残ります。ドライブの本は削除されません)`)) return;
        await deleteBook(b.bookId);
        await refreshLibrary();
      });
      li.append(text, open, del);
      return li;
    }),
  );
  empty.textContent = 'まだありません。ドライブから開いた本は、自動で端末に保存されます。';
  empty.hidden = books.length > 0;

  const st = await storageInfo();
  const total = books.reduce((n, b) => n + b.size, 0);
  const parts = [`保存した本: ${books.length}冊、${fmtSize(total)}`];
  if (st.usage !== null && st.quota !== null) parts.push(`このサイト全体の使用量: ${fmtSize(st.usage)} / 上限の目安 ${fmtSize(st.quota)}`);
  if (st.persisted !== null) parts.push(st.persisted ? '自動削除されない保存: 許可済み' : '自動削除されない保存: 未許可(空き容量が少ないとブラウザが削除する場合があります)');
  info.textContent = parts.join(' ・ ');
}

// ---------- 起動 ----------

openDriveBtn.addEventListener('click', () => void openFromDrive());
void refreshLibrary();

if (!driveConfigured()) {
  openDriveBtn.disabled = true;
  showMessage('Google Cloud の設定が未設定のため、ドライブから開けません。docs/setup.md を参照してください。', true);
}

if (import.meta.env.DEV) {
  // 開発用: 端末のPDFを開く(保存・オフラインの確認用に、端末内にも保存する)
  const localBtn = $<HTMLButtonElement>('open-local');
  const localInput = $<HTMLInputElement>('local-input');
  localBtn.hidden = false;
  localBtn.addEventListener('click', () => localInput.click());
  localInput.addEventListener('change', async () => {
    const f = localInput.files?.[0];
    if (!f) return;
    showMessage('');
    try {
      const bookId = `local:${f.name}:${f.size}`;
      await saveToDevice(bookId, f.name, null, f);
      await openBook(bookId, f.name, await f.arrayBuffer());
    } catch (e) {
      showMessage((e as Error).message, true);
    } finally {
      void refreshLibrary();
    }
  });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // アプリ本体をオフラインで起動できるようにする(G-4)。書籍データは含まない。
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
