/**
 * OCRで読み取った文字の整形(純粋関数)。
 * tesseract の日本語は、文字と文字の間に空白や改行を入れることがある。日本語どうしの間は詰め、
 * 英数字の単語どうしの間は、空白を1つ残す。
 */

/** 空白を詰めてよい、日本語の文字(ひらがな・カタカナ・漢字・全角記号・全角英数) */
const CJK = '\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const BETWEEN_CJK = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'gu');
const AFTER_CJK = new RegExp(`([${CJK}])\\s+(?=\\S)`, 'gu');
const BEFORE_CJK = new RegExp(`(\\S)\\s+(?=[${CJK}])`, 'gu');

export function normalizeOcrText(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  s = s.replace(BETWEEN_CJK, '$1');
  s = s.replace(AFTER_CJK, '$1').replace(BEFORE_CJK, '$1'); // 日本語と英数字の境目の空白・改行も詰める
  s = s.replace(/[ \t]*\n+[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/** 書き方(縦書き/横書き)。既定は開き方向から推定する(右開き=縦書き) */
export type Orientation = 'vertical' | 'horizontal';

export function defaultOrientation(openDirection: 'rtl' | 'ltr'): Orientation {
  return openDirection === 'rtl' ? 'vertical' : 'horizontal';
}
