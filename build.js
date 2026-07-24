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

fs.mkdirSync('dist', { recursive: true });

// (1) standalone: 完全なHTML文書。GitHub Pages / オフライン配布用。
const standalone = `<!DOCTYPE html>
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
fs.writeFileSync('dist/standalone.html', standalone);
console.log('built dist/standalone.html', standalone.length, 'bytes');

// (2) artifact: ラッパー無し（DOCTYPE/html/head/body を付けない）。
// Claude Artifact はこれ自体を head/body で包むため、二重の <html>/<body> を
// 避けないと height:100vh などが効かずレイアウトが崩れる。
const artifact = `<title>${title}</title>
${style}
${body}
<script>
${bundle}
</script>`;
fs.writeFileSync('dist/artifact.html', artifact);
console.log('built dist/artifact.html', artifact.length, 'bytes');
