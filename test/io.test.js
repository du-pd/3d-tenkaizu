// 入出力の検証: バイナリ/ASCII STLのパース、DXF構造の健全性。
import { parseSTL, weldTriangleSoup } from '../src/parse.js';
import { buildTriMesh, mergeCoplanar } from '../src/mesh.js';
import { buildSpanningTree, unfoldMesh } from '../src/unfold.js';
import { buildLayout } from '../src/layout.js';
import { toDXF, toLaserSVG } from '../src/render.js';
import { cube } from './shapes.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ok  - ' + n); } else { fail++; console.log('  FAIL- ' + n + ' ' + e); } };

// --- バイナリSTLを合成してパース ---
function makeBinarySTL(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12; // 法線ゼロ
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return buf;
}
function makeAsciiSTL(tris) {
  let s = 'solid test\n';
  for (const t of tris) {
    s += 'facet normal 0 0 0\n outer loop\n';
    for (const v of t) s += `  vertex ${v[0]} ${v[1]} ${v[2]}\n`;
    s += ' endloop\nendfacet\n';
  }
  s += 'endsolid test\n';
  return new TextEncoder().encode(s).buffer;
}

const tris = cube(20);
console.log('== STL入出力 ==');
const binTris = parseSTL(makeBinarySTL(tris));
check('バイナリSTL: 三角形数', binTris.length === tris.length, `${binTris.length}`);
const asciiTris = parseSTL(makeAsciiSTL(tris));
check('ASCII STL: 三角形数', asciiTris.length === tris.length, `${asciiTris.length}`);
const wb = weldTriangleSoup(binTris);
const wa = weldTriangleSoup(asciiTris);
check('両者とも8頂点に溶接', wb.vertices.length === 8 && wa.vertices.length === 8);

// 壊れたバイナリSTL（三角形数だけ大きい）はエラーを投げる
console.log('== 破損検出 ==');
let threw = false;
try {
  const bad = new ArrayBuffer(84 + 50); // 1三角形分しかない
  new DataView(bad).setUint32(80, 100, true); // 100と偽る
  parseSTL(bad);
} catch (e) { threw = true; }
check('破損STLでエラーを投げる（握りつぶさない）', threw);

// --- DXF構造 ---
console.log('== DXF出力 ==');
const w = weldTriangleSoup(tris);
const m = mergeCoplanar(buildTriMesh(w.vertices, w.triangles));
const t = buildSpanningTree(m);
const r = unfoldMesh(m, t);
const layout = buildLayout(m, r, { tabs: true });
const dxf = toDXF(layout);
const lines = dxf.split(/\r\n/);
const count = (s) => lines.filter((l) => l === s).length;
// HEADER / TABLES / BLOCKS / ENTITIES の4セクション
check('DXF: SECTION/ENDSEC 対応(4)', count('SECTION') === count('ENDSEC') && count('SECTION') === 4);
check('DXF: EOF あり', lines.includes('EOF'));
check('DXF: R12ヘッダ($ACADVER=AC1009)', dxf.includes('$ACADVER') && dxf.includes('AC1009'));
check('DXF: LTYPE CONTINUOUS 定義あり(Illustrator対策)', dxf.includes('LTYPE') && dxf.includes('CONTINUOUS'));
check('DXF: STYLE STANDARD 定義あり', dxf.includes('STYLE') && dxf.includes('STANDARD'));
check('DXF: BLOCKSセクションあり', dxf.includes('BLOCKS'));
check('DXF: CUTレイヤーのLINEあり', dxf.includes('LINE') && dxf.includes('CUT'));
check('DXF: SCOREレイヤーあり', dxf.includes('SCORE'));
check('DXF: mm単位($INSUNITS=4)', dxf.includes('$INSUNITS'));

// LINEの数 = CUT本数 + SCORE本数（のりしろは3辺）と辻褄が合うか（下限チェック）
const nLine = count('LINE');
check('DXF: LINEエンティティが十分ある', nLine >= r.foldEdges.length, `${nLine}`);

// 実際のDXFパーサで構文検証（Illustrator/CAD互換の担保）
try {
  const { default: DxfParser } = await import('dxf-parser');
  const parsed = new DxfParser().parseSync(dxf);
  const layers = Object.keys(parsed.tables.layer.layers);
  check('DXF: パーサで解析成功', parsed.entities.length > 0);
  check('DXF: CUT/SCOREレイヤーが定義済み', layers.includes('CUT') && layers.includes('SCORE'));
  check('DXF: 全エンティティのレイヤーが定義済み',
    parsed.entities.every((e) => layers.includes(e.layer)));
} catch (e) {
  check('DXF: パーサで解析成功', false, e.message);
}

// レーザーSVGのストロークがヘアライン
const lsvg = toLaserSVG(layout)[0];
check('レーザーSVG: CUTが赤', lsvg.includes('#FF0000'));
check('レーザーSVG: SCOREが青', lsvg.includes('#0000FF'));

// --- ページ分割: 複数パーツが1枚に収まらなければ複数ページへ ---
console.log('== ページ分割 ==');
{
  // 6個の離れた立方体 → 6パーツ。小さい用紙で複数ページに分かれる
  let tris6 = [];
  for (let i = 0; i < 6; i++) {
    const o = [(i % 3) * 80, Math.floor(i / 3) * 80, 0];
    for (const t of cube(30)) tris6.push(t.map((v) => [v[0] + o[0], v[1] + o[1], v[2] + o[2]]));
  }
  const w6 = weldTriangleSoup(tris6);
  const m6 = mergeCoplanar(buildTriMesh(w6.vertices, w6.triangles));
  const r6 = unfoldMesh(m6, buildSpanningTree(m6));
  check('6個の離れた立方体 → 6パーツ', r6.parts.length === 6, `${r6.parts.length}`);
  const L6 = buildLayout(m6, r6, { tabs: true, tabHeight: 4, pageW: 100, pageH: 100 });
  check('小用紙で複数ページに分割', L6.pages.length > 1, `pages=${L6.pages.length}`);
  const placed6 = L6.pages.reduce((s, p) => s + p.parts.length, 0);
  check('全パーツがいずれかのページに配置', placed6 === r6.parts.length, `${placed6}/${r6.parts.length}`);
  // 大きい用紙なら1ページに収まる
  const Lbig = buildLayout(m6, r6, { tabs: true, tabHeight: 4, pageW: 420, pageH: 594 });
  check('大用紙なら1ページ', Lbig.pages.length === 1, `pages=${Lbig.pages.length}`);
}

console.log(`\n=== 合計: ${pass} ok, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
