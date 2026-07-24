// 単一HTMLファイル版をビルドする。
// 全ESモジュールを esbuild でIIFEにバンドルし、index.html にインライン展開する。
// オフライン配布・埋め込みプレビュー用（正規の配信は index.html + src/ のまま）。
import { build } from 'esbuild';
import fs from 'fs';

const res = await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'iife',
  write: false,
});
const bundle = res.outputFiles[0].text;

const html = fs.readFileSync('index.html', 'utf8');
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
const body = html
  .match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/<script[^>]*><\/script>/, '');

const out = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
${style}
</head>
<body>
${body}
<script>
${bundle}
</script>
</body>
</html>`;

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/standalone.html', out);
console.log('built dist/standalone.html', out.length, 'bytes');
