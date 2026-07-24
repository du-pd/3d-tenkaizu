// UI 配線: ファイル読込 → 展開 → プレビュー → SVG/DXF 出力。
import { parseSTL, parseOBJ, weldTriangleSoup, weldPolygons } from './parse.js';
import { buildTriMesh, mergeCoplanar } from './mesh.js';
import { buildSpanningTree, unfoldMesh } from './unfold.js';
import { buildLayout } from './layout.js';
import { toPaperSVG, toLaserSVG, toDXF } from './render.js';
import { Viewer3D } from './viewer3d.js';
import { cube, tetrahedron, octahedron, dodecahedron } from '../test/shapes.js';

const $ = (id) => document.getElementById(id);

const state = {
  triMesh: null,   // 溶接直後（マージ前）
  mesh: null,      // マージ後
  unfold: null,
  layout: null,
  modelName: 'model',
};

const viewer = new Viewer3D($('view3d'));

function log(msg, cls = '') {
  const el = $('status');
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function clearLog() { $('status').innerHTML = ''; }

function paperSize() {
  const p = $('paper').value;
  if (p === 'a3') return { pageW: 297, pageH: 420 };
  if (p === 'custom') {
    return {
      pageW: Math.max(10, parseFloat($('pageW').value) || 300),
      pageH: Math.max(10, parseFloat($('pageH').value) || 600),
    };
  }
  return { pageW: 210, pageH: 297 }; // A4
}

function modelExtent(mesh) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices) for (let k = 0; k < 3; k++) {
    if (v[k] < mn[k]) mn[k] = v[k];
    if (v[k] > mx[k]) mx[k] = v[k];
  }
  return { size: [mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]] };
}

// --- 読み込み共通処理 ---
function loadTriangleSoup(tris, name) {
  clearLog();
  state.modelName = name;
  try {
    const welded = weldTriangleSoup(tris);
    log(`溶接: 生三角形 ${tris.length} → 頂点 ${welded.vertices.length} / 面 ${welded.triangles.length}`, 'ok');
    if (welded.degenerate > 0) log(`注意: 面積ゼロの縮退三角形を ${welded.degenerate} 個除去しました`, 'warn');
    finishLoad(welded);
  } catch (e) {
    log('読み込みエラー: ' + e.message, 'err');
    console.error(e);
  }
}

function finishLoad(welded) {
  const tri = buildTriMesh(welded.vertices, welded.triangles);
  state.triMesh = tri;
  // 破損チェックは握りつぶさず警告
  if (tri.stats.boundary > 0)
    log(`警告: 境界辺(穴/開いた辺)が ${tri.stats.boundary} 本あります。閉じた立体でないと組み立てられません。`, 'warn');
  if (tri.stats.nonManifold > 0)
    log(`警告: 非多様体辺(3面以上が共有)が ${tri.stats.nonManifold} 本あります。モデルを見直してください。`, 'warn');
  if (tri.stats.boundary === 0 && tri.stats.nonManifold === 0)
    log('メッシュ健全性チェック: 穴なし・非多様体なし ✓', 'ok');

  const ext = modelExtent(tri);
  log(`モデル寸法: ${ext.size.map((s)=>s.toFixed(1)).join(' × ')} (STL単位=mm想定)`);
  viewer.setMesh(tri);
  unfoldNow();
}

// --- 展開実行 ---
function unfoldNow() {
  if (!state.triMesh) { log('先にモデルを読み込んでください', 'warn'); return; }
  const mergeDeg = parseFloat($('mergeAngle').value) || 0.1;
  const merged = mergeCoplanar(state.triMesh, mergeDeg * Math.PI / 180);
  state.mesh = merged;
  log(`平面マージ: ${state.triMesh.faces.length} 三角形 → ${merged.faces.length} 面`, 'ok');

  const tree = buildSpanningTree(merged);
  const unfold = unfoldMesh(merged, tree);
  state.unfold = unfold;

  // スケール（実寸指定）
  let scale = 1;
  const targetH = parseFloat($('targetHeight').value);
  if (targetH > 0) {
    const ext = modelExtent(merged);
    const modelH = Math.max(...ext.size);
    scale = targetH / modelH;
  }

  const page = paperSize();
  const baseOpts = {
    tabs: $('useTabs').checked,
    tabHeight: parseFloat($('tabHeight').value) || 5,
    engrave: $('engrave').checked,
    pageW: page.pageW,
    pageH: page.pageH,
  };

  // 用紙自動フィット: 最大パーツが用紙内に収まるよう縮小（実寸ではなくなる旨は警告）
  let autofit = false;
  if ($('autofit').checked) {
    const probe = buildLayout(merged, unfold, { ...baseOpts, scale });
    let maxW = 0, maxH = 0;
    for (const pd of probe.parts) { maxW = Math.max(maxW, pd.bbox.w); maxH = Math.max(maxH, pd.bbox.h); }
    const usableW = page.pageW - 20, usableH = page.pageH - 20;
    const fit = Math.min(usableW / maxW, usableH / maxH);
    if (fit < 1) { scale *= fit * 0.98; autofit = true; }
  }

  const layout = buildLayout(merged, unfold, { ...baseOpts, scale });
  state.layout = layout;
  state.scale = scale;

  log(`展開完了: パーツ ${unfold.parts.length} 個 / 折り線 ${unfold.foldEdges.length} / 切り線 ${unfold.cutEdges.length}`, 'ok');
  if (unfold.parts.length > 1)
    log(`重なり回避のため ${unfold.parts.length} パーツに分割しました（辺番号で貼り合わせ）`, 'warn');
  log(`用紙: ${page.pageW} × ${page.pageH} mm / ページ数: ${layout.pages.length}${scale !== 1 ? ` / スケール ×${scale.toFixed(3)}` : ''}`);
  if (autofit)
    log('用紙に自動フィットで縮小しました。この出力は実寸ではありません（印刷寸法は指定値と異なります）。', 'warn');
  else if (layout.overflow)
    log('警告: 用紙に収まらないパーツがあります。「用紙に自動フィット」をオンにするか、目標寸法を小さくしてください。', 'warn');

  // 3Dビューの辺色分け（折り=緑, 切り=赤）
  const ec = new Map();
  for (const f of unfold.foldEdges) ec.set(f.key, f.mountain ? '#e05555' : '#4477dd');
  for (const c of unfold.cutEdges) ec.set(c.key, '#22aa44');
  viewer.setEdgeColors(ec);

  renderPreview();
}

function currentSVGs() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'laser') {
    return toLaserSVG(state.layout, { engrave: $('engrave').checked });
  }
  return toPaperSVG(state.layout, { numbers: true });
}

function renderPreview() {
  if (!state.layout) return;
  const svgs = currentSVGs();
  const holder = $('preview');
  holder.innerHTML = '';
  svgs.forEach((svg, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page';
    wrap.innerHTML = svg;
    const label = document.createElement('div');
    label.className = 'pagelabel';
    label.textContent = `ページ ${i + 1} / ${svgs.length}`;
    holder.appendChild(label);
    holder.appendChild(wrap);
  });
}

// --- ダウンロード ---
function download(filename, text, mime = 'image/svg+xml') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadSVG() {
  if (!state.layout) return;
  const svgs = currentSVGs();
  const mode = document.querySelector('input[name="mode"]:checked').value;
  svgs.forEach((svg, i) => {
    const suffix = svgs.length > 1 ? `_p${i + 1}` : '';
    download(`${state.modelName}_${mode}${suffix}.svg`, svg);
  });
}
function downloadDXF() {
  if (!state.layout) return;
  const dxf = toDXF(state.layout, { scoreFolds: true });
  download(`${state.modelName}_laser.dxf`, dxf, 'application/dxf');
}

// --- イベント配線 ---
$('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.obj')) {
      const text = await file.text();
      const { vertices, faces } = parseOBJ(text);
      clearLog();
      state.modelName = name;
      const welded = weldPolygons(vertices, faces);
      log(`OBJ読込: 頂点 ${vertices.length} / 面 ${faces.length}`, 'ok');
      finishLoad(welded);
    } else {
      const buf = await file.arrayBuffer();
      const tris = parseSTL(buf);
      loadTriangleSoup(tris, name);
    }
  } catch (err) {
    clearLog();
    log('読み込み失敗: ' + err.message, 'err');
    console.error(err);
  }
});

const samples = { cube, tetra: tetrahedron, octa: octahedron, dodeca: dodecahedron };
document.querySelectorAll('[data-sample]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const gen = samples[btn.dataset.sample];
    loadTriangleSoup(gen(40), btn.dataset.sample);
  });
});

$('unfoldBtn').addEventListener('click', unfoldNow);
$('dlSvg').addEventListener('click', downloadSVG);
$('dlDxf').addEventListener('click', downloadDXF);
$('printBtn').addEventListener('click', () => window.print());
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', renderPreview));
['mergeAngle', 'tabHeight', 'targetHeight', 'useTabs', 'engrave', 'autofit', 'pageW', 'pageH'].forEach((id) =>
  $(id).addEventListener('change', () => { if (state.triMesh) unfoldNow(); }));

// 用紙サイズ切替: カスタム時のみW×H入力を表示
$('paper').addEventListener('change', () => {
  $('customSize').hidden = $('paper').value !== 'custom';
  if (state.triMesh) unfoldNow();
});

// 初期表示: 立方体
loadTriangleSoup(cube(40), 'cube');
window.__state = state; // デバッグ/テスト用
