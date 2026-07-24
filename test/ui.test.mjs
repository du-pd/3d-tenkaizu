import { chromium } from 'playwright';
import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { cube } from '../src/samples.js';

// 6個の離れた立方体のバイナリSTLを生成（複数ページ印刷の検証用）
function sixCubesSTL() {
  const tris = [];
  for (let i = 0; i < 6; i++) {
    const o = [(i % 3) * 80, Math.floor(i / 3) * 80, 0];
    for (const t of cube(30)) tris.push(t.map((v) => [v[0] + o[0], v[1] + o[1], v[2] + o[2]]));
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) { dv.setFloat32(off, v[0], true); dv.setFloat32(off + 4, v[1], true); dv.setFloat32(off + 8, v[2], true); off += 12; }
    off += 2;
  }
  mkdirSync('scratch', { recursive: true });
  writeFileSync('scratch/six.stl', Buffer.from(buf));
  return 'scratch/six.stl';
}

// Chromium の実行パスを解決する。環境変数優先、次に playwright 既定、
// 最後に /opt/pw-browsers を走査（web実行環境などプリインストール対応）。
function resolveChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try { const p = chromium.executablePath(); if (existsSync(p)) return p; } catch {}
  const base = '/opt/pw-browsers';
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = `${base}/${d}/${sub}`;
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // playwright に任せる
}

const browser = await chromium.launch({ executablePath: resolveChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:8123/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// 初期ロードで立方体が展開されているはず
const status = await page.$eval('#status', (el) => el.innerText);
console.log('--- 初期ステータス(cube) ---\n' + status);

// 各サンプルで展開してエラーが出ないか
for (const s of ['dodeca', 'cube']) {
  await page.click(`[data-sample="${s}"]`);
  await page.waitForTimeout(300);
  const st = await page.$eval('#status', (el) => el.innerText);
  const parts = (st.match(/パーツ (\d+) 個/) || [])[1];
  const svgCount = await page.$$eval('#preview .page svg', (els) => els.length);
  console.log(`${s}: parts=${parts}, previewSVG=${svgCount}`);
}

// レーザーモードに切替→SVGにCUT/SCOREレイヤーがあるか
await page.click('input[name="mode"][value="laser"]');
await page.waitForTimeout(200);
const svgHTML = await page.$eval('#preview .page svg', (el) => el.outerHTML);
console.log('laser svg has CUT layer:', /id="cut"/.test(svgHTML));
console.log('laser svg has SCORE layer:', /id="score"/.test(svgHTML));
console.log('laser svg mm units:', /mm"/.test(svgHTML));

// 実寸スケール: 目標150mm
await page.fill('#targetHeight', '150');
await page.dispatchEvent('#targetHeight', 'change');
await page.waitForTimeout(300);
const st2 = await page.$eval('#status', (el) => el.innerText);
console.log('scale applied:', /スケール ×/.test(st2));

// A4オーバーフロー警告（大きな十二面体）→ 自動フィットで解消
await page.click('input[name="mode"][value="paper"]');
await page.fill('#targetHeight', '0');
await page.click('[data-sample="dodeca"]');
await page.fill('#targetHeight', '300');
await page.dispatchEvent('#targetHeight', 'change');
await page.waitForTimeout(300);
const st3 = await page.$eval('#status', (el) => el.innerText);
console.log('overflow warned:', /印刷範囲に収まらない/.test(st3));
await page.click('#autofit');
await page.waitForTimeout(300);
const st4 = await page.$eval('#status', (el) => el.innerText);
console.log('autofit applied:', /自動フィット/.test(st4));

// 用紙サイズ: A4 / A3 / カスタム で SVG viewBox が変わるか
await page.click('[data-sample="cube"]');
const vb = () => page.$eval('#preview .page svg', (el) => el.getAttribute('viewBox'));
await page.selectOption('#paper', 'a3'); await page.waitForTimeout(200);
console.log('A3 viewBox:', await vb(), '=>', (await vb()) === '0 0 297 420' ? 'ok' : 'FAIL');
await page.selectOption('#paper', 'custom'); await page.waitForTimeout(200);
const custVisible = await page.$eval('#customSize', (el) => getComputedStyle(el).display !== 'none');
console.log('custom fields visible:', custVisible, '/ default viewBox:', await vb());
await page.selectOption('#paper', 'a4'); await page.waitForTimeout(200);
const custHidden = await page.$eval('#customSize', (el) => getComputedStyle(el).display === 'none');
console.log('custom fields hidden on A4:', custHidden);

// スマホ幅で3Dプレビュー(canvas)の高さが0にならないこと(#4)
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const canvasH = await page.$eval('#view3d', (c) => c.getBoundingClientRect().height);
console.log('mobile canvas height:', Math.round(canvasH), canvasH > 50 ? 'ok' : 'FAIL');
if (canvasH <= 50) errors.push('mobile canvas height collapsed: ' + canvasH);
await page.setViewportSize({ width: 1400, height: 900 });

// 複数ページ印刷: プレビューのページ数と印刷PDFのシート数が一致すること
{
  const stl = sixCubesSTL();
  await page.setInputFiles('#file', stl);
  await page.waitForTimeout(500);
  const prevPages = await page.$$eval('#preview .page', (e) => e.length);
  await page.pdf({ path: 'scratch/ui_print.pdf', preferCSSPageSize: true });
  const pdf = readFileSync('scratch/ui_print.pdf');
  const m = /\/Count\s+(\d+)/.exec(pdf.toString('latin1'));
  const pdfPages = m ? parseInt(m[1], 10) : 0;
  console.log(`print: preview pages=${prevPages}, PDF sheets=${pdfPages}`, prevPages > 1 && pdfPages === prevPages ? 'ok' : 'FAIL');
  if (!(prevPages > 1 && pdfPages === prevPages)) errors.push(`print sheets mismatch: preview=${prevPages} pdf=${pdfPages}`);
}

await page.screenshot({ path: 'scratch/ui.png', fullPage: false });

console.log('\n=== console errors:', errors.length, '===');
errors.forEach((e) => console.log('  ' + e));
await browser.close();
process.exit(errors.length ? 1 : 0);
