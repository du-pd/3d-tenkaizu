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
check('DXF: SECTION/ENDSEC 対応', count('SECTION') === count('ENDSEC') && count('SECTION') === 3);
check('DXF: EOF あり', lines.includes('EOF'));
check('DXF: CUTレイヤーのLINEあり', dxf.includes('LINE') && dxf.includes('CUT'));
check('DXF: SCOREレイヤーあり', dxf.includes('SCORE'));
check('DXF: mm単位($INSUNITS=4)', dxf.includes('$INSUNITS'));

// LINEの数 = CUT本数 + SCORE本数（のりしろは3辺）と辻褄が合うか（下限チェック）
const nLine = count('LINE');
check('DXF: LINEエンティティが十分ある', nLine >= r.foldEdges.length, `${nLine}`);

// レーザーSVGのストロークがヘアライン
const lsvg = toLaserSVG(layout)[0];
check('レーザーSVG: CUTが赤', lsvg.includes('#FF0000'));
check('レーザーSVG: SCOREが青', lsvg.includes('#0000FF'));

console.log(`\n=== 合計: ${pass} ok, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
