/**
 * 同期データの形式(要件定義書 4章)。第1段階で確定し、後から変えない。
 *
 * 原則:
 * - ページは「物理位置」(PDFのページ番号 + 左/右)で持つ。論理ページ・通し番号・印刷番号は
 *   表示や出力のたびに BookSettings から計算する(pages.ts)。
 * - 座標は元画像基準の正規化座標(0〜1)。分割位置やトリミングを変えても影響しない。
 * - 本の識別は Google ドライブのファイルID。
 * - 同期は項目ごと/注釈1件ごとの更新日時で統合する。削除は deleted の印を残す。
 */

export const SCHEMA_VERSION = 1 as const;

/** L=左半分, R=右半分, W=分割しないページ全体(ページ単位の上書き用) */
export type Side = 'L' | 'R' | 'W';

/** 物理位置。pdfPage は 1 始まり。 */
export interface PageRef {
  pdfPage: number;
  side: Side;
}

/** 元画像基準の正規化矩形(0〜1) */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NormPoint {
  x: number;
  y: number;
}

export type OpenDirection = 'rtl' | 'ltr'; // rtl=右開き(右ページが先), ltr=左開き

/** ページ単位の上書き(画面は第1段階では作らない。形式だけ用意する) */
export interface PageOverride {
  /** false のとき、このページは分割しない(side='W' として扱う) */
  split?: boolean;
  /** このページだけの分割位置(0〜1) */
  splitPosition?: number;
  /** ページ単位の余白調整。分割後のページ範囲に対する相対矩形(画面で見たままの向き) */
  crop?: NormRect;
}

/** 本ごとの設定。updatedAt は項目ごとの更新日時(ミリ秒)で、同期時に項目ごとに新しい方を採用する。 */
export interface BookSettings {
  splitPosition: number; // 既定 0.5
  openDirection: OpenDirection; // 既定 rtl
  /** 1枚目の扱い。'both'=左右とも本文、'L'/'R'=その側だけが本文(表紙など) */
  firstPage: 'both' | 'L' | 'R';
  /** 通し番号 serial が印刷ページ printed に当たる(例: 通し番号8=印刷p.1)。未設定は null */
  printedNumber: { serial: number; printed: number } | null;
  landscapeLayout: 'single' | 'double'; // 第2段階
  zoomKeep: boolean; // 第2段階
  /** 本ごとの共通枠(右ページ用。分割しない1ページ=Wも使う)。分割後のページ範囲に対する相対矩形で、画面で見たままの向き */
  cropFrame: NormRect | null;
  /** 左ページ用の共通枠(画面で見たままの向き)。null=未設定: 右ページ用を左右反転して使う(従来の動き) */
  cropFrameLeft: NormRect | null;
  /** キーは pdfPage の文字列(見開き1枚単位: split/splitPosition)。
   *  ページ単位の余白(crop)だけは "<pdfPage>:<L|R|W>" をキーにする(左右で別々に持つため)。 */
  pageOverrides: Record<string, PageOverride>;
}

export type BookSettingsKey = keyof BookSettings;

export const DEFAULT_SETTINGS: BookSettings = {
  splitPosition: 0.5,
  openDirection: 'rtl',
  firstPage: 'both',
  printedNumber: null,
  landscapeLayout: 'single',
  zoomKeep: false,
  cropFrame: null,
  cropFrameLeft: null,
  pageOverrides: {},
};

/** 最後に読んだ位置(日時が新しい方を採用) */
export interface ReadingPosition {
  page: PageRef;
  updatedAt: number;
}

/** 名前つきページ(しおり・目次)。注釈と同じ統合規則。 */
export interface NamedPage {
  id: string;
  kind: 'bookmark' | 'toc';
  title: string;
  page: PageRef;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export type AnnotationColor = 'yellow' | 'green' | 'pink' | 'blue';

interface AnnotationBase {
  id: string;
  page: PageRef;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface HighlightRect extends AnnotationBase {
  kind: 'highlight-rect';
  color: AnnotationColor;
  rect: NormRect;
  /** 囲んだ箇所の文字(OCRで読み取って保存した、または手で直した文字)。無ければ未取得 */
  ocrText?: string;
}

export interface HighlightStroke extends AnnotationBase {
  kind: 'highlight-stroke';
  color: AnnotationColor;
  points: NormPoint[];
  /** 線の太さ(元画像の幅に対する割合) */
  width: number;
  /** 囲んだ箇所の文字(OCRで読み取って保存した、または手で直した文字)。無ければ未取得 */
  ocrText?: string;
}

export interface Memo extends AnnotationBase {
  kind: 'memo';
  at: NormPoint;
  text: string;
}

export type Annotation = HighlightRect | HighlightStroke | Memo;

/** 読書の記録の日付1件。date は YYYY-MM-DD(端末の暦)。null は「消した」 */
export interface ReadingDate {
  date: string | null;
  updatedAt: number;
  /** 手で入れた・直した値か。false は、自動(初めて開いた日)の値 */
  manual: boolean;
}

/** 読み始めた日と読了日。4章の形式への追加(省略可。古いデータには無い) */
export interface ReadingRecord {
  startedAt?: ReadingDate;
  finishedAt?: ReadingDate;
}

/** ドライブのアプリ専用領域に、本1冊につき1ファイルで保存する同期データ */
export interface BookSyncDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  /** GoogleドライブのファイルID */
  bookId: string;
  settings: BookSettings;
  settingsUpdatedAt: Partial<Record<BookSettingsKey, number>>;
  position: ReadingPosition | null;
  namedPages: NamedPage[];
  annotations: Annotation[];
  /** 読み始めた日・読了日(第5回で追加。無い場合は記録なし) */
  reading?: ReadingRecord;
}

export function newBookSyncDocument(bookId: string): BookSyncDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    bookId,
    settings: { ...DEFAULT_SETTINGS, pageOverrides: {} },
    settingsUpdatedAt: {},
    position: null,
    namedPages: [],
    annotations: [],
  };
}
