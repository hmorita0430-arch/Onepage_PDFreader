# OCR 用ファイル

- `lang/jpn.traineddata`, `lang/jpn_vert.traineddata`: tesseract-ocr/tessdata_fast(Apache License 2.0)。
  https://github.com/tesseract-ocr/tessdata_fast
- `worker.min.js`, `core/`: ビルド時に `node_modules/tesseract.js`(Apache License 2.0)・`tesseract.js-core` からコピーする(`vite.config.ts`)。リポジトリには含めない。
- 書籍の画像・文字は、端末の外へ送らない(すべて端末内で処理する)。
