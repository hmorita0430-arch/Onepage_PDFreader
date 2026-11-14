import { describe, expect, it } from 'vitest';
import { defaultOrientation, normalizeOcrText } from '../src/ocr/text';
import { addRect, addMemo, setHighlightText, visibleAnnotations } from '../src/model/annotations';
import { mergeDocuments } from '../src/sync/merge';
import { newBookSyncDocument, type Annotation, type HighlightRect } from '../src/model/types';
import { buildMarkdown } from '../src/export/markdown';
import { markdownFor, type ExportPackage } from '../src/export/exporter';
import { loadIncludeImages, saveIncludeImages } from '../src/export/options';

describe('OCRの文字の整形', () => {
  it('日本語どうしの間の空白・改行を詰める', () => {
    expect(normalizeOcrText('吾 輩 は 猫 で あ る')).toBe('吾輩は猫である');
    expect(normalizeOcrText('経済成長と\n環境保護の\n両立')).toBe('経済成長と環境保護の両立');
    expect(normalizeOcrText('読書は 心の　栄養')).toBe('読書は心の栄養');
  });
  it('英数字の単語どうしの間は、空白を1つ残す', () => {
    expect(normalizeOcrText('Strategy is   choosing\nwhat not')).toBe('Strategy is choosing what not');
  });
  it('日本語と英数字の境目の空白は詰める', () => {
    expect(normalizeOcrText('第 2 章 AI の 歴史')).toBe('第2章AIの歴史');
  });
  it('前後の空白を取り、空なら空', () => {
    expect(normalizeOcrText('  \n 吾輩 \n')).toBe('吾輩');
    expect(normalizeOcrText('   \n  ')).toBe('');
    expect(normalizeOcrText('')).toBe('');
  });
  it('句読点・記号を含む文でも、文字を落とさない', () => {
    expect(normalizeOcrText('読書は 心の栄養であり、 静かな時間に。')).toBe('読書は心の栄養であり、静かな時間に。');
  });
  it('書き方の既定: 右開き=縦書き、左開き=横書き', () => {
    expect(defaultOrientation('rtl')).toBe('vertical');
    expect(defaultOrientation('ltr')).toBe('horizontal');
  });
});

describe('蛍光ペンの箇所の文字(保存・同期)', () => {
  const page = { pdfPage: 1, side: 'R' as const };
  const rect = { x: 0.5, y: 0.2, w: 0.3, h: 0.1 };
  const make = (): Annotation[] => addRect([], { page, color: 'yellow', rect }, 100, 'h1');

  it('文字を保存すると、更新日時が進む。前後の空白は取る', () => {
    const list = setHighlightText(make(), 'h1', '  吾輩は猫である  ', 200);
    const a = list[0] as HighlightRect;
    expect(a.ocrText).toBe('吾輩は猫である');
    expect(a.updatedAt).toBe(200);
  });
  it('空にすると、項目ごと消えて未取得に戻る(更新日時は進む)', () => {
    const withText = setHighlightText(make(), 'h1', '吾輩', 200);
    const cleared = setHighlightText(withText, 'h1', '   ', 300)[0] as HighlightRect;
    expect('ocrText' in cleared).toBe(false);
    expect(cleared.updatedAt).toBe(300);
  });
  it('メモには付かない。他の注釈は変えない', () => {
    const list = addMemo(make(), { page, at: { x: 0.1, y: 0.1 }, text: 'メモ' }, 150, 'm1');
    const out = setHighlightText(list, 'm1', '文字', 400);
    expect(out[1]).toEqual(list[1]);
    expect((setHighlightText(list, 'h1', 'x', 400)[1] as Annotation)).toEqual(list[1]);
  });
  it('他の端末への同期: 新しい方の文字が残る(古い端末の未取得に負けない)', () => {
    const a = newBookSyncDocument('b');
    const b = newBookSyncDocument('b');
    a.annotations = make(); // 未取得(updatedAt=100)
    b.annotations = setHighlightText(make(), 'h1', '読み取った文字', 500);
    const m = mergeDocuments(a, b);
    expect((visibleAnnotations(m.annotations)[0] as HighlightRect).ocrText).toBe('読み取った文字');
    expect(mergeDocuments(b, a).annotations).toEqual(m.annotations);
  });
  it('同じ箇所を両方で直した場合は、新しい方', () => {
    const a = newBookSyncDocument('b');
    const b = newBookSyncDocument('b');
    a.annotations = setHighlightText(make(), 'h1', 'Aの文字', 300);
    b.annotations = setHighlightText(make(), 'h1', 'Bの文字', 400);
    expect((mergeDocuments(a, b).annotations[0] as HighlightRect).ocrText).toBe('Bの文字');
  });
});

describe('書き出し: 保存した文字', () => {
  it('Markdownに「」つきで出る。文字がなければ「文字データなし」', () => {
    const md = buildMarkdown({
      title: '本',
      exportedAt: new Date(2026, 10, 14, 9, 0),
      pages: [{ label: '通し番号1', imagePath: null, items: [{ kind: 'highlight', colorLabel: '黄', ocr: '吾輩は猫である' }, { kind: 'highlight', colorLabel: '青', ocr: null }] }],
    });
    expect(md).toContain('- **蛍光ペン(黄)**: 「吾輩は猫である」');
    expect(md).toContain('- **蛍光ペン(青)**: (文字データなし)');
    expect(md).toContain('OCR(文字認識)で読み取ったもの');
  });

  it('読書の記録の行: 記録がある本だけ、出力日時の下に入る', () => {
    const base = { title: '本', exportedAt: new Date(2026, 10, 14, 9, 0), pages: [{ label: 'p.1', imagePath: null, items: [] }] };
    const withReading = buildMarkdown({ ...base, reading: '2026/11/01 〜 2026/11/14(14日間)' });
    expect(withReading).toContain('- 出力日時: 2026-11-14 09:00\n- 読書の記録: 2026/11/01 〜 2026/11/14(14日間)\n- メモ 0件 / 蛍光ペン 0件');
    expect(buildMarkdown(base)).not.toContain('読書の記録');
    expect(buildMarkdown({ ...base, reading: '' })).not.toContain('読書の記録');
  });
  it('注釈のID(プレビュー用)は、Markdownに出さない', () => {
    const md = buildMarkdown({
      title: '本', exportedAt: new Date(2026, 10, 14), pages: [{ label: 'p.1', imagePath: null, items: [{ kind: 'memo', id: 'secret-id-1', n: 1, text: 'メモ' }] }],
    });
    expect(md).not.toContain('secret-id-1');
  });
});

describe('書き出し: ページ画像のオン・オフ', () => {
  const pkg: ExportPackage = {
    title: '本', images: [{ name: 'page-001.jpg', blob: new Blob(['x']) }], hasImages: true, reading: '', exportedAt: new Date(2026, 10, 14, 9, 0),
    pageCount: 1, memoCount: 1, highlightCount: 0,
    notePages: [{ label: '通し番号1', imagePath: 'images/page-001.jpg', items: [{ kind: 'memo', n: 1, text: 'メモ' }] }],
  };
  it('オン: 画像のリンクが入る', () => {
    expect(markdownFor(pkg, true)).toContain('![通し番号1](images/page-001.jpg)');
  });
  it('オフ: 画像のリンクが入らない。見出し・メモは残る', () => {
    const md = markdownFor(pkg, false);
    expect(md).not.toContain('![');
    expect(md).not.toContain('images/');
    expect(md).toContain('## 通し番号1');
    expect(md).toContain('- **メモ1**: メモ');
  });
  it('オフを渡しても、元の内容(notePages)は書き換えない', () => {
    markdownFor(pkg, false);
    expect(pkg.notePages[0]?.imagePath).toBe('images/page-001.jpg');
  });
  it('選択の保存: 既定はオン。オフにすると覚える', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    expect(loadIncludeImages()).toBe(true);
    saveIncludeImages(false);
    expect(loadIncludeImages()).toBe(false);
    saveIncludeImages(true);
    expect(loadIncludeImages()).toBe(true);
  });
});
