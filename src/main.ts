import './style.css';
import { driveConfigured } from './config';
import { DriveAuth, type ConnectionState } from './drive/auth';
import { AuthExpiredError, downloadResumable, fetchFileInfo } from './drive/download';
import { pickFolder, pickPdf } from './drive/picker';
import {
  effectiveCrop,
  isFullRect,
  marginsToRect,
  mirrorRect,
  pageCropKey,
  rectToMargins,
  type Margins,
} from './model/crop';
import { formatShownLabel, groupAt, nextIndex, normalizeIndex, prevIndex, type Shown, type ViewSpec } from './model/layout';
import { buildPageList, clampIndex, findIndex, formatPageLabel, regionOf, type LogicalPage } from './model/pages';
import { loadBase, loadBookDocument, saveBase, saveBookDocument } from './model/storage';
import { keyAction, tapZone } from './model/tap';
import type { BookSettings, BookSyncDocument, PageOverride, PageRef } from './model/types';
import {
  deleteBook,
  getBlob,
  getMeta,
  latestBook,
  listBooks,
  requestPersistence,
  saveBook,
  sortBooks,
  storageInfo,
  touchBook,
  type LibrarySort,
} from './offline/library';
import { countUnsynced, incomingChanges, mergeDocuments, positionPending, type Incoming } from './sync/merge';
import { isSyncable, syncBook } from './sync/remote';
import { createAnnotator } from './ui/annotate';
import { createNav } from './ui/nav';
import { clearDestination, describeDestination, loadDestination, saveDestination } from './export/destination';
import { exportNotes, highlightTexts } from './export/exporter';
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
/** いま表示している範囲と、PDFページ全体の大きさ(注釈の座標変換に使う) */
let shownSpec: ViewSpec | null = null;
let pageSize: Size = { w: 1, h: 1 };
/** 開いている本の名前(書き出しのフォルダ名に使う) */
let bookName = '';
/** 前回の同期で確定した内容。未同期の件数を求める基準 */
let base: BookSyncDocument | null = null;
let syncing = false;
let syncAgain = false;
let syncError: string | null = null;
let syncTimer: ReturnType<typeof setTimeout> | undefined;

// ---------- 接続状態(G-3: 切れても読書は止めない) ----------

const CONN_TEXT: Record<ConnectionState, string> = {
  disconnected: '未接続(読書は続けられます)',
  connected: '接続中',
  expired: '接続が切れました(読書は続けられます)',
};

/** 上部バー用の短い表示(長いと、狭い画面でボタンが画面の外へ押し出される) */
const CONN_TEXT_SHORT: Record<ConnectionState, string> = {
  disconnected: '未接続',
  connected: '接続中',
  expired: '接続切れ',
};

function renderConnection(state: ConnectionState): void {
  const start = $('conn-start');
  start.textContent = CONN_TEXT[state];
  start.classList.toggle('expired', state === 'expired');
  const bar = $('conn-reader');
  bar.textContent = CONN_TEXT_SHORT[state];
  bar.title = CONN_TEXT[state]; // 長押し・ホバーで詳しい説明
  bar.classList.toggle('expired', state === 'expired');
  // 未接続でも「接続」ボタンを出す(以前は、切れた後にしか出なかった)
  for (const id of ['reconnect-start', 'reconnect-reader']) {
    const btn = $(id);
    btn.hidden = state === 'connected' || !driveConfigured();
    // 上部バーでは短く(「接続」「再接続」)、開始画面では分かりやすく(「ドライブに接続」)
    btn.textContent = state === 'expired' ? '再接続' : id === 'reconnect-reader' ? '接続' : 'ドライブに接続';
  }
}
auth.onChange(renderConnection);
auth.onChange((state) => {
  renderSyncStatus();
  if (state === 'connected') void syncNow(); // 再接続したら、保留していた同期を再開する
  if (state === 'expired') armAutoReconnect();
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
  pushReaderHistory(); // 「戻る」で、開始画面に戻れるようにする
  doc = loadBookDocument(bookId);
  base = loadBase(bookId);
  syncError = null;
  bookName = name;
  $('title').textContent = name;
  // 接続中なら、描画の前に同期して、他端末の最後に読んだ位置・設定・しおりを反映する(G-2)。
  // 通信が遅くても開くのを待たせない(5秒で打ち切り、同期はそのまま続ける)
  if (isSyncable(bookId) && auth.currentToken()) {
    await Promise.race([syncNow(), new Promise<void>((r) => setTimeout(r, 5000))]);
  }
  renderSyncStatus();
  positionDirty = !doc.position; // 初めて開く本だけ、開いた位置を保存する。それ以外は、移動するまで保存しない
  syncSettingsForm();
  pages = buildPageList(viewer.numPages, doc.settings);
  index = doc.position ? findIndex(pages, doc.position.page) : 0; // N-1: 最後に読んだ位置から開く
  view = { ...RESET_VIEW };
  setMenuVisible(false);
  armAutoReconnect();
  await renderCurrent();
  showIntroMenu(); // 開いた直後に、数秒だけ、メニューとページ番号を見せる
}

/** @param viaBack ブラウザの「戻る」で閉じる場合。履歴は、ブラウザがすでに1つ戻している */
function closeBook(viaBack = false): void {
  clearTimeout(introTimer);
  flushPosition();
  void syncNow(); // 閉じる前の変更を、接続中なら送る
  nav.reset();
  annot.reset();
  readerEl.classList.remove('annotating');
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
  if (!viaBack) popReaderHistory();
  void refreshLibrary();
}

// ---------- 戻る操作(ブラウザの「戻る」・Androidの戻るジェスチャー) ----------
//
// 本を開いている間だけ、履歴を1つ積んでおく(番兵)。「戻る」でそれが取り除かれたら、
//   1. 開いている画面(メモ入力・メニュー・一覧・余白設定・設定・注釈ツール)があれば、1つ閉じて、番兵を積み直す
//   2. 何も開いていなければ、本を閉じて開始画面へ
// メニューバー(上下のバー)は「画面」に数えない(戻るで、すぐ開始画面に戻れるように)。

let sentinelActive = false;
let ignoreNextPop = false;
const SENTINEL = { app: 'reader' };

function pushReaderHistory(): void {
  if (sentinelActive) return;
  history.pushState(SENTINEL, '');
  sentinelActive = true;
}

/** 本をボタンなどで閉じたとき、積んだ履歴を取り除く(「戻る」を1回余計に押させないため) */
function popReaderHistory(): void {
  if (!sentinelActive) return;
  sentinelActive = false;
  ignoreNextPop = true;
  history.back();
}

/** 前面にある画面を1つ閉じる。閉じたものがあれば true */
function closeTopOverlay(): boolean {
  if (annot.isEditorOpen()) {
    annot.closeEditor();
    return true;
  }
  if (annot.isMenuOpen()) {
    annot.closeMenu();
    return true;
  }
  if (annot.isOneShot()) {
    annot.cancelOneShot();
    return true;
  }
  if (nav.isOpen()) {
    nav.close();
    return true;
  }
  if (cropping) {
    exitCrop(true);
    return true;
  }
  if (!settingsEl.hidden) {
    settingsEl.hidden = true;
    return true;
  }
  if (annot.isActive()) {
    annot.exit();
    return true;
  }
  return false;
}

window.addEventListener('popstate', () => {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    return;
  }
  if (!doc) {
    // 本を閉じたあとの「進む」で、読書画面の履歴へ入ってしまった。何も起きない状態になるので、元に戻す
    if ((history.state as { app?: string } | null)?.app === 'reader') {
      ignoreNextPop = true;
      history.back();
    }
    return;
  }
  sentinelActive = false; // ブラウザが、読書画面の履歴を1つ戻した
  if (closeTopOverlay()) pushReaderHistory(); // 次の「戻る」のために、積み直す
  else closeBook(true);
});

// 本を開いたまま読み込み直した(更新ボタンなど)ときは、古い読書画面の履歴が1つ残っている。
// そのままだと、開始画面の最初の「戻る」が何も起きないので、起動時に1つ戻って取り除く。
if ((history.state as { app?: string } | null)?.app === 'reader') {
  ignoreNextPop = true;
  setTimeout(() => (ignoreNextPop = false), 1500); // 戻る先が無く、何も起きなかった場合に、次の「戻る」を飲み込まない
  history.back();
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
  annot.setZoom(view.z);
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
    fit = result.fit;
    pageSize = result.page;
    shownSpec = shown.spec;
    applyView();
    updateCropOverlay();
    annot.render();
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
  positionDirty = true; // 利用者が移動した。この位置を「最後に読んだ位置」として保存する
  // ズーム維持でなければ、ページを送るたびにフィット表示へ戻る(D-9)
  if (!doc.settings.zoomKeep) view = { ...RESET_VIEW };
  void renderCurrent();
}

const goNext = () => go(nextIndex(pages, index, isDouble()));
const goPrev = () => go(prevIndex(pages, index, isDouble()));

/** @param auto 自動(開いた直後の表示の自動非表示)による切り替え。利用者の操作なら、自動非表示を取り消す */
function setMenuVisible(visible: boolean, auto = false): void {
  if (!auto) clearTimeout(introTimer);
  topbar.hidden = !visible;
  bottombar.hidden = !visible;
  if (!visible) settingsEl.hidden = true;
}

// ---------- 開いた直後のメニュー(数秒だけ) ----------

const INTRO_MENU_MS = 3000;
let introTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 本を開いた直後の数秒だけ、メニュー(上下のバー)とページ番号を出して、自動で隠す。
 * 利用者がメニューに触れた(タップ・押下・キー操作・画面を開く)ら、自動では隠さない。
 */
function showIntroMenu(): void {
  setMenuVisible(true, true);
  clearTimeout(introTimer);
  introTimer = setTimeout(() => {
    if (!doc || topbar.hidden) return;
    if (!settingsEl.hidden || nav.isOpen() || annot.isActive() || cropping) return; // 何か開いていれば、隠さない
    setMenuVisible(false, true);
  }, INTRO_MENU_MS);
}
for (const el of [topbar, bottombar, settingsEl]) el.addEventListener('pointerdown', () => clearTimeout(introTimer));

// ---------- 最後に読んだ位置(N-1) ----------

let positionTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * 利用者がページを移動した(まだ保存していない)。
 * 位置の更新日時は「新しい方が勝つ」ため、移動していないのに「いま」の時刻で保存し直してはいけない。
 * (画面サイズの変化・画面を隠す・閉じるたびに保存し直すと、動いていない端末の古い位置が、
 *  他の端末の新しい位置に勝ってしまう)
 */
let positionDirty = false;

function schedulePositionSave(): void {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(flushPosition, 400);
}

function flushPosition(): void {
  clearTimeout(positionTimer);
  const page = pages[index];
  if (!doc || !page || cropping || !positionDirty) return;
  positionDirty = false;
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
const syncHint = $('sync-hint');
const syncHintText = $('sync-hint-text');

/** 最後に、ドライブ上の最新の状態を確認できた時刻 */
let lastCheckedAt: number | null = null;
/** 直近の同期で何が起きたか(数秒だけ表示する) */
let activityNote: string | null = null;
let noteTimer: ReturnType<typeof setTimeout> | undefined;
/** 前回の同期後のドライブ上の版。変わっていなければ、本体の読み込みを省く */
let remoteVersion: string | undefined;
let hintTimer: ReturnType<typeof setTimeout> | undefined;
let hintTarget: PageRef | null = null;

const hhmm = (t: number) => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

/** 画面に出す「未同期の件数」。読書位置は、ページを送るたびに変わるので含めない */
function unsyncedCount(): number {
  return doc && isSyncable(doc.bookId) ? countUnsynced(doc, base, { includePosition: false }) : 0;
}

/** 同期が必要かどうかの判断用(読書位置を含む) */
function pendingTotal(): number {
  return doc && isSyncable(doc.bookId) ? countUnsynced(doc, base) : 0;
}

/**
 * 同期の状態を、常に表示する(G-3)。
 * 「最新」は、ドライブ上の状態を確認できた時刻を示す(自分の変更を送っただけでは「最新」とは言えないため)。
 */
function renderSyncStatus(): void {
  if (!doc || !isSyncable(doc.bookId)) {
    syncBadge.hidden = true;
    syncText.textContent = '開発用に開いた本は同期しません';
    return;
  }
  syncBadge.hidden = false;
  const n = unsyncedCount();
  const connected = auth.state === 'connected';
  let text: string;
  if (syncing) text = '同期中…';
  else if (n > 0) text = `未同期 ${n}件${connected ? '' : '(接続待ち)'}`;
  else if (!connected) text = doc && positionPending(doc, base) ? '未接続(読書位置のみ未送信)' : '未接続(送っていない変更はありません)';
  else text = lastCheckedAt ? `最新(${hhmm(lastCheckedAt)}に確認)` : '確認中…';
  if (activityNote) text += ` ・ ${activityNote}`;
  if (syncError) text += ` ・ ${syncError}`;
  syncBadge.textContent = text;
  syncBadge.classList.toggle('pending', !syncing && n > 0);
  syncBadge.classList.toggle('error', Boolean(syncError));
  syncText.textContent = `${text}。${connected ? 'ドライブに接続中です。' : '接続が切れています。「ドライブに接続」または「今すぐ同期」で再開できます。'}`;
}

function setNote(text: string): void {
  activityNote = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    activityNote = null;
    renderSyncStatus();
  }, 8000);
}

function describeIncoming(i: Incoming): string {
  const parts: string[] = [];
  if (i.namedPages > 0) parts.push(`しおり・目次${i.namedPages}件`);
  if (i.annotations > 0) parts.push(`注釈${i.annotations}件`);
  if (i.settings > 0) parts.push(`設定${i.settings}項目`);
  if (i.position) parts.push('読書位置');
  return parts.join('、');
}

/** 他の端末で、より先(または別の場所)まで読んでいるとき、移動するか尋ねる(勝手には動かさない) */
function showPositionHint(ref: PageRef): void {
  if (!doc || pages.length === 0) return;
  hintTarget = ref;
  syncHintText.textContent = `他の端末の読書位置: ${formatPageLabel(findIndex(pages, ref), doc.settings)}`;
  syncHint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 20000);
}

function hideHint(): void {
  syncHint.hidden = true;
  hintTarget = null;
  clearTimeout(hintTimer);
}
$('sync-hint-go').addEventListener('click', () => {
  if (hintTarget) go(findIndex(pages, hintTarget));
  hideHint();
});
$('sync-hint-close').addEventListener('click', hideHint);

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

/** 同期の結果を取り込む。同期中に手元で変えた分も、統合し直して取りこぼさない。取り込んだ変更を返す。 */
function applyMerged(bookId: string, result: BookSyncDocument): Incoming {
  const local = doc && doc.bookId === bookId ? doc : loadBookDocument(bookId);
  const incoming = incomingChanges(local, result);
  const settingsBefore = JSON.stringify(local.settings);
  const merged = mergeDocuments(local, result);
  saveBookDocument(merged);
  saveBase(result);
  if (!doc || doc.bookId !== bookId) return incoming;
  doc = merged;
  base = result;
  if (JSON.stringify(doc.settings) !== settingsBefore) {
    syncSettingsForm();
    if (pages.length > 0) rebuildPages();
  }
  nav.refresh();
  annot.render();
  return incoming;
}

async function syncNow(): Promise<void> {
  if (!doc || !isSyncable(doc.bookId)) return;
  const token = auth.currentToken();
  if (!token || !navigator.onLine) {
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
  const outgoing = unsyncedCount();
  try {
    // 手元に送るものが無く、ドライブ上も変わっていなければ、本体は読み込まない
    const result = await syncBook(doc, token, fetch, { knownVersion: pendingTotal() === 0 ? remoteVersion : undefined });
    remoteVersion = result.version;
    lastCheckedAt = Date.now();
    if (!result.skipped) {
      const incoming = applyMerged(bookId, result.merged);
      const parts: string[] = [];
      if (result.uploaded && outgoing > 0) parts.push(`↑${outgoing}件を送信`);
      if (incoming.total > 0) parts.push(`↓他の端末から ${describeIncoming(incoming)} を取り込み`);
      if (parts.length > 0) setNote(parts.join(' / '));
      const current = pages[index]?.ref;
      const theirs = doc?.position?.page;
      if (incoming.position && theirs && current && (theirs.pdfPage !== current.pdfPage || theirs.side !== current.side)) {
        showPositionHint(theirs);
      }
    }
  } catch (e) {
    if (e instanceof AuthExpiredError) auth.expire();
    else syncError = '通信エラーで同期できませんでした';
  } finally {
    syncing = false;
    renderSyncStatus();
    // 同期中に増えた変更があれば、もう一度(エラー時は無限に繰り返さない)
    if (!syncError && auth.currentToken() && (syncAgain || pendingTotal() > 0)) scheduleSync(syncAgain ? 500 : 5000);
    syncAgain = false;
  }
}

// 他の端末の変更を「受け取る」ための確認: 一定間隔、画面に戻ったとき、ネットワークが戻ったとき
const POLL_MS = 30_000;
setInterval(() => {
  if (document.visibilityState === 'visible' && doc && !cropping) void syncNow();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncNow();
});
window.addEventListener('focus', () => void syncNow());
window.addEventListener('online', () => void syncNow());

// 接続が切れたあと、次の画面操作で自動的に再接続を試みる(ポップアップは操作の直後にしか開けないため)。
// 失敗・キャンセルしても繰り返さない(「再接続」ボタンから行える)。
const AUTO_RECONNECT_KEY = 'auto-reconnect:v1';
const autoReconnectEnabled = (): boolean => {
  try {
    return localStorage.getItem(AUTO_RECONNECT_KEY) !== 'off';
  } catch {
    return true;
  }
};
let autoArmed = false;
function armAutoReconnect(): void {
  if (autoArmed || !doc || !driveConfigured() || !autoReconnectEnabled() || auth.state !== 'expired') return;
  autoArmed = true;
  document.addEventListener(
    'pointerdown',
    () => {
      autoArmed = false;
      if (auth.state === 'expired') void auth.reconnect().catch(() => undefined);
    },
    { once: true },
  );
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
    annot.render();
  },
  editMemo: (id) => annot.editMemo(id),
  ocrTexts: (annos) => highlightTexts(viewer, annos),
  exportNotes: (onProgress) => runExport(onProgress),
  destinationLabel: () => describeDestination(exportDest),
  chooseDestination: (report) => chooseDestination(report),
});

// ---------- 注釈(蛍光ペン・位置つきメモ) ----------

const annot = createAnnotator(
  {
    getDoc: () => doc,
    getGeom: () => (doc && shownSpec ? { spec: shownSpec, fit, page: pageSize, box: hostBox(), view } : null),
    prev: () => goPrev(),
    next: () => goNext(),
    commit: () => {
      if (!doc) return;
      saveBookDocument(doc);
      markDirty();
      nav.refresh();
    },
    onModeChange: (active) => {
      readerEl.classList.toggle('annotating', active);
      if (active) {
        setMenuVisible(false);
        readerEl.style.setProperty('--panel-h', `${$('ann-bar').offsetHeight}px`);
      } else {
        readerEl.style.removeProperty('--panel-h');
      }
      void renderCurrent(); // 表示領域の大きさが変わるので、フィットし直す
    },
  },
  viewer.pageEl,
);
$('open-ann').addEventListener('click', () => {
  if (!cropping) annot.enter();
});

// ---------- 操作: タップ / スワイプ / ピンチ / ホイール / キー ----------

attachGestures(stageEl, {
  ...annot.draw, // 描画ツールの使用中は、タップによるページ送りを行わない(O-4)
  // 読書中の長押し(タッチ)で、その場にメモを置く。右クリック(マウス)で、メモ・蛍光ペンのメニューを出す
  onLongPress: (x, y) => {
    if (doc && !cropping && !annot.isActive() && !nav.isOpen()) annot.placeMemoAt(x, y);
  },
  onContextMenu: (x, y) => {
    if (doc && !cropping && !nav.isOpen()) annot.openContextMenu(x, y);
  },
  isZoomed: () => isZoomed(view),
  // 上部の帯(上約20%)はメニュー、その下の左右の端25%ずつがページ送り、中央がメニュー(ダブルタップは拡大)
  zone: (xf, yf) => {
    if (!doc) return 'center';
    const z = tapZone(xf, yf, doc.settings.openDirection);
    return z === 'band' ? 'band' : z === 'center' ? 'center' : 'edge';
  },
  onEdgeTap: (xf, yf) => {
    if (!doc) return;
    const z = tapZone(xf, yf, doc.settings.openDirection);
    if (z === 'next') goNext();
    else if (z === 'prev') goPrev();
  },
  onBandTap: () => {
    if (doc && !cropping) setMenuVisible(Boolean(topbar.hidden));
  },
  onCenterTap: () => {
    if (doc && !cropping) setMenuVisible(Boolean(topbar.hidden));
  },
  onDoubleTap: (x, y) => {
    if (!doc) return;
    view = zoomAt(hostBox(), fit, view, isZoomed(view) ? 1 : DOUBLE_TAP_Z, x, y);
    applyView();
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
    if (e.key === 'Escape') closeTopOverlay();
    return;
  }
  if (annot.isEditorOpen()) return; // メモの入力中。文字入力を妨げない
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  // 元に戻す/やり直す(注釈ツールの使用中): Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  if ((e.ctrlKey || e.metaKey) && annot.isActive()) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      annot.undo();
      return;
    }
    if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      annot.redo();
      return;
    }
  }
  if (e.key === 'Escape') {
    if (!closeTopOverlay()) setMenuVisible(false);
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
// 注釈の書き出し(A-4, A-5): 注釈つきの画像とMarkdownを、ドライブの通常フォルダへ保存する
const exportBtn = $<HTMLButtonElement>('export-notes');
const exportStatus = $('export-status');
const exportLink = $<HTMLAnchorElement>('export-link');

/** 書き出し先(アプリ全体で1つ。この端末内に保存)。null なら既定のマイドライブ/読書ノート */
let exportDest = loadDestination();

function renderExportDest(): void {
  $('export-dest').textContent = describeDestination(exportDest);
  $('export-dest-reset').hidden = exportDest === null;
  nav.refresh();
}

/**
 * ドライブの標準ピッカーで、書き出し先のフォルダを選ぶ。選ぶことで、このアプリにそのフォルダへの書き込みを許可する。
 * 操作の直後に呼ぶこと(接続のポップアップを開くため)。
 */
async function chooseDestination(report: (message: string) => void): Promise<void> {
  if (!navigator.onLine) throw new Error('オフラインです。接続してから、保存先を選んでください。');
  const token = await auth.ensureToken();
  const picked = await pickFolder(token);
  if (!picked) return; // キャンセル。今の保存先のまま
  exportDest = { id: picked.id, name: picked.name };
  saveDestination(exportDest);
  renderExportDest();
  report(`保存先を「${picked.name}」にしました。次の書き出しから、この中の「本の名前」フォルダに保存します。`);
}

/** 読書ノートを書き出す。設定画面と、注釈の一覧画面の両方から呼ぶ。失敗は例外(文言は利用者向け)。 */
async function runExport(onProgress: (message: string) => void): Promise<{ message: string; url: string }> {
  if (!doc) throw new Error('本が開かれていません');
  const token = auth.currentToken();
  if (!token) {
    throw new Error('ドライブに接続していません。「ドライブに接続」(または「再接続」)を押してから、もう一度お試しください。');
  }
  try {
    const r = await exportNotes({ doc, pages, bookName, viewer, token, onProgress, destination: exportDest });
    return {
      message: `書き出しました(${r.pageCount}ページ、メモ${r.memoCount}件、蛍光ペン${r.highlightCount}件)。保存先: ${r.locationLabel}`,
      url: r.folderUrl,
    };
  } catch (e) {
    if (e instanceof AuthExpiredError) {
      auth.expire();
      throw new Error('接続が切れました。再接続してから、もう一度お試しください。');
    }
    throw e; // DestinationError(保存先を使えない)も、利用者向けの文言のまま伝える
  }
}

$('export-dest-pick').addEventListener('click', () => {
  exportLink.hidden = true;
  chooseDestination((m) => (exportStatus.textContent = m)).catch((e: Error) => (exportStatus.textContent = e.message));
});
$('export-dest-reset').addEventListener('click', () => {
  clearDestination();
  exportDest = null;
  renderExportDest();
  exportStatus.textContent = '保存先を既定(マイドライブ/読書ノート)に戻しました。';
});
renderExportDest();

exportBtn.addEventListener('click', async () => {
  exportLink.hidden = true;
  exportBtn.disabled = true;
  try {
    const r = await runExport((m) => (exportStatus.textContent = m));
    exportStatus.textContent = r.message;
    exportLink.href = r.url;
    exportLink.hidden = false;
  } catch (e) {
    exportStatus.textContent = (e as Error).message;
  } finally {
    exportBtn.disabled = false;
  }
});

const autoReconnectChk = $<HTMLInputElement>('set-autoreconnect');
autoReconnectChk.checked = autoReconnectEnabled();
autoReconnectChk.addEventListener('change', () => {
  try {
    localStorage.setItem(AUTO_RECONNECT_KEY, autoReconnectChk.checked ? 'on' : 'off');
  } catch {
    /* 保存できなくても、この回は反映される */
  }
});
$('disconnect').addEventListener('click', () => {
  if (!confirm('この端末に保存した、ドライブへの接続情報を消しますか?\n(しおりや設定、保存した本は消えません。再び使うには、もう一度接続します)')) return;
  auth.disconnect();
  renderSyncStatus();
});
$('close-settings').addEventListener('click', () => (settingsEl.hidden = true));
$('close-settings-x').addEventListener('click', () => (settingsEl.hidden = true));

// 設定を、右へのスワイプで閉じる。縦スクロールを優先し(横の動きが縦の2倍以上のときだけ)、
// スライダー・入力欄・選択欄の上で始めた操作は対象にしない(それらの操作を妨げない)。
const SWIPE_CLOSE_PX = 80;
let settingsSwipe: { x: number; y: number; id: number } | null = null;
settingsEl.addEventListener('pointerdown', (e) => {
  settingsSwipe = null;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  settingsSwipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
});
settingsEl.addEventListener('pointerup', (e) => {
  const s = settingsSwipe;
  settingsSwipe = null;
  if (!s || s.id !== e.pointerId) return;
  const dx = e.clientX - s.x;
  const dy = e.clientY - s.y;
  if (dx >= SWIPE_CLOSE_PX && Math.abs(dx) > Math.abs(dy) * 2) settingsEl.hidden = true;
});
settingsEl.addEventListener('pointercancel', () => (settingsSwipe = null)); // ブラウザが縦スクロールを始めた等
$('back').addEventListener('click', () => closeBook());

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
  annot.exit();
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

const SORT_KEY = 'library-sort:v1';
let librarySort: LibrarySort = (() => {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent';
  } catch {
    return 'recent';
  }
})();
const sortSel = $<HTMLSelectElement>('library-sort');
sortSel.value = librarySort;
sortSel.addEventListener('change', () => {
  librarySort = sortSel.value === 'name' ? 'name' : 'recent';
  try {
    localStorage.setItem(SORT_KEY, librarySort);
  } catch {
    /* 保存できなくても、この回は反映される */
  }
  void refreshLibrary();
});

const continueBtn = $<HTMLButtonElement>('continue-book');
let continueId: string | null = null;
continueBtn.addEventListener('click', () => {
  if (continueId) void openSaved(continueId);
});

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
  // 「続きから読む」: 最後に開いた本。ある間は、ドライブから開くボタンを控えめな見た目にする
  const last = latestBook(books);
  continueId = last?.bookId ?? null;
  continueBtn.hidden = !last;
  if (last) $('continue-name').textContent = `${last.name} ・ 最後に開いた日: ${fmtDate(last.lastOpenedAt)}`;
  openDriveBtn.classList.toggle('primary', !last);
  openDriveBtn.classList.toggle('secondary', Boolean(last));
  list.replaceChildren(
    ...sortBooks(books, librarySort).map((b) => {
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

if (driveConfigured()) void auth.preload();

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

$('version').textContent = `バージョン ${__APP_VERSION__}`;
$('version-reader').textContent = `バージョン ${__APP_VERSION__}`;
$('update-reload').addEventListener('click', () => location.reload());

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // アプリ本体をオフラインで起動できるようにする(G-4)。書籍データは含まない。
  const hadController = Boolean(navigator.serviceWorker.controller);
  // 新しい版が配信されたら、開いている画面は古いままなので、更新を促す(初回の導入時は出さない)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('update-banner').hidden = false;
  });
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      // 開きっぱなしのアプリでも、画面に戻ったときに新しい版を確認する
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
      });
    })
    .catch(() => undefined);
}
