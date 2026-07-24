// のりしろ干渉・付け根の線種・破線分割のテスト。
import { weldTriangleSoup } from '../src/parse.js';
import { buildTriMesh, mergeCoplanar } from '../src/mesh.js';
import { buildSpanningTree, unfoldMesh } from '../src/unfold.js';
import { buildLayout, fitTabHeight, makeTabPoly, polyOverlap } from '../src/layout.js';
import { toLaserSVG, toDXF, dashSegments, scoreSegments, foldSegments, patternSegments } from '../src/render.js';
import { len2, sub2 } from '../src/vec.js';
import { cube, octahedron, dodecahedron } from '../src/samples.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ok  - ' + n); } else { fail++; console.log('  FAIL- ' + n + ' ' + e); } };

function layoutOf(gen, opts) {
  const w = weldTriangleSoup(gen(40));
  const m = mergeCoplanar(buildTriMesh(w.vertices, w.triangles));
  const r = unfoldMesh(m, buildSpanningTree(m));
  return buildLayout(m, r, { tabs: true, ...opts });
}

// ---- 1. のりしろ干渉: 解決後は重なりが無い（不変条件） ----
console.log('== のりしろ干渉 ==');
for (const [name, gen] of [['cube', cube], ['octa', octahedron], ['dodeca', dodecahedron]]) {
  const L = layoutOf(gen, { tabHeight: 6 });
  let overlaps = 0;
  for (const pd of L.parts) {
    const tabs = pd.tabs;
    for (let i = 0; i < tabs.length; i++) {
      // 他ののりしろと重ならない
      for (let j = i + 1; j < tabs.length; j++) if (polyOverlap(tabs[i].outer, tabs[j].outer)) overlaps++;
      // 自分の付く面以外の本体面と重ならない
      for (const poly of pd.polys) if (poly.face !== tabs[i].fi && polyOverlap(tabs[i].outer, poly.coords)) overlaps++;
    }
  }
  check(`${name}: 解決後にのりしろ重なりが無い`, overlaps === 0, `overlaps=${overlaps}`);
  check(`${name}: tabStatsが数値`, Number.isInteger(L.tabStats.shortened) && Number.isInteger(L.tabStats.deleted));
}
// 干渉が実際に発生し、削除される形状（十二面体）で解決が働くこと
{
  const L = layoutOf(dodecahedron, { tabHeight: 6 });
  check('dodeca: 干渉で削除が発生', L.tabStats.deleted > 0, JSON.stringify(L.tabStats));
}

// fitTabHeight を直接テスト（短縮・削除・素通しを決定的に）
console.log('== fitTabHeight ==');
{
  const base = [[0, 0], [10, 0]];
  const faceCoords = [[0, 0], [10, 0], [10, -10], [0, -10]]; // 面は base の下側→タブは上へ
  const angle = Math.PI / 4;
  // 障害物なし → フル高さ
  const hFull = fitTabHeight(base, faceCoords, [], { h0: 5, minH: 1.5, angle });
  check('障害物なしでフル高さ', Math.abs(hFull - 5) < 1e-6, `${hFull}`);
  // 上方 距離3 に障害物 → 3付近に短縮
  const obstacle = [[-5, 3], [15, 3], [15, 8], [-5, 8]];
  const hShort = fitTabHeight(base, faceCoords, [obstacle], { h0: 5, minH: 1.5, angle });
  check('障害物ありで短縮される', hShort !== null && hShort < 5 && hShort > 1.5, `${hShort}`);
  check('短縮後は重ならない', hShort !== null && !polyOverlap(makeTabPoly(base[0], base[1], faceCoords, hShort, angle), obstacle));
  // 障害物が近すぎ(距離0.5) → minH未満 → 削除(null)
  const near = [[-5, 0.5], [15, 0.5], [15, 5], [-5, 5]];
  const hDel = fitTabHeight(base, faceCoords, [near], { h0: 5, minH: 1.5, angle });
  check('近すぎる障害物で削除(null)', hDel === null, `${hDel}`);
}

// ---- 2. のりしろ付け根=SCORE、外周=CUT ----
console.log('== 付け根の線種 ==');
{
  const L = layoutOf(cube, { tabHeight: 5 });
  const totTabs = L.parts.reduce((s, p) => s + p.tabs.length, 0);
  const totFold = L.parts.reduce((s, p) => s + p.foldLines.length, 0);
  const totCut = L.parts.reduce((s, p) => s + p.cutLines.length, 0);
  check('立方体にのりしろがある', totTabs > 0, `${totTabs}`);

  const svg = toLaserSVG(L, {})[0];
  const scoreGroup = svg.match(/id="score"[^>]*>([\s\S]*?)<\/g>/)[1];
  const cutGroup = svg.match(/id="cut"[^>]*>([\s\S]*?)<\/g>/)[1];
  const scoreLines = (scoreGroup.match(/<line/g) || []).length;
  const cutLines = (cutGroup.match(/<line/g) || []).length;
  const cutPolylines = (cutGroup.match(/<polyline/g) || []).length;
  // SCORE = 折り線 + のりしろ付け根（実線モードなので各1本）
  check('SCORE本数 = 折り線 + のりしろ付け根', scoreLines === totFold + totTabs, `score=${scoreLines} fold=${totFold} tabs=${totTabs}`);
  // CUT = 切り線(line) + のりしろ外周(polyline)
  check('CUT: のりしろ外周はpolylineでtab数だけ', cutPolylines === totTabs, `${cutPolylines} vs ${totTabs}`);
  check('CUT: 切り線はlineでcutLines数だけ', cutLines === totCut, `${cutLines} vs ${totCut}`);

  // DXF: SCORE層に付け根が含まれる（付け根の長さのLINEが存在）
  const dxf = toDXF(L, { scoreFolds: true });
  check('DXF: SCOREレイヤーが存在', dxf.includes('SCORE'));
}

// ---- 3. 破線: 長さ・間隔・中央揃え ----
console.log('== 破線分割 ==');
{
  // 長さ10, 破線3, 間隔2 → 2本、[1,4] と [6,9]（中央揃え）
  const segs = dashSegments([0, 0], [10, 0], 3, 2);
  check('破線本数=2', segs.length === 2, `${segs.length}`);
  check('各破線長=3', segs.every((s) => Math.abs(len2(sub2(s[1], s[0])) - 3) < 1e-6));
  check('先頭が中央揃え(開始1.0)', Math.abs(segs[0][0][0] - 1) < 1e-6, `${segs[0][0][0]}`);
  check('間隔=2', Math.abs(segs[1][0][0] - segs[0][1][0] - 2) < 1e-6, `${segs[1][0][0] - segs[0][1][0]}`);
  // 短辺は最低1本
  const shortSeg = dashSegments([0, 0], [2, 0], 3, 2);
  check('短辺は1本', shortSeg.length === 1, `${shortSeg.length}`);
  // scoreSegments: 実線=1本, 破線=複数
  check('scoreSegments 実線は1本', scoreSegments([0, 0], [10, 0], { dashed: false }).length === 1);
  check('scoreSegments 破線は複数', scoreSegments([0, 0], [10, 0], { dashed: true, len: 3, gap: 2 }).length > 1);

  // レーザーSVG/DXF: 破線ありは実線より SCORE 線分が増える
  const L = layoutOf(cube, { tabHeight: 5 });
  const solidScore = (toLaserSVG(L, {})[0].match(/id="score"[^>]*>([\s\S]*?)<\/g>/)[1].match(/<line/g) || []).length;
  const dashedScore = (toLaserSVG(L, { dash: { dashed: true, len: 2, gap: 1.5 } })[0].match(/id="score"[^>]*>([\s\S]*?)<\/g>/)[1].match(/<line/g) || []).length;
  check('レーザーSVG: 破線でSCORE線分が増える', dashedScore > solidScore, `solid=${solidScore} dashed=${dashedScore}`);
  const solidDxf = (toDXF(L, { scoreFolds: true }).match(/SCORE/g) || []).length;
  const dashedDxf = (toDXF(L, { scoreFolds: true, dash: { dashed: true, len: 2, gap: 1.5 } }).match(/SCORE/g) || []).length;
  check('DXF: 破線でSCORE要素が増える', dashedDxf > solidDxf, `solid=${solidDxf} dashed=${dashedDxf}`);
}

// ---- 4. 山折り/谷折りのパターン区別 ----
console.log('== 山谷パターン区別 ==');
{
  const P = [0, 0], Q = [40, 0];
  // patternSegments: 一点鎖線 [3,2,0.6,2] は周期7.6。40mmに5周期→各2区間=10本
  const ps = patternSegments(P, Q, [3, 2, 0.6, 2]);
  check('patternSegments: 一点鎖線が dash+dot に分割', ps.length === 10, `${ps.length}`);
  check('patternSegments: dot(短線分<1mm)を含む', ps.some((s) => { const L = len2(sub2(s[1], s[0])); return L > 0 && L < 1.0; }));

  const dash = { dashed: true, len: 3, gap: 2, distinguish: true };
  const val = foldSegments(P, Q, dash, 'valley');
  const mtn = foldSegments(P, Q, dash, 'mountain');
  check('区別ON: 谷=破線(全区間 長さ3)', val.every((s) => Math.abs(len2(sub2(s[1], s[0])) - 3) < 1e-6));
  check('区別ON: 山と谷でパターン(本数)が異なる', mtn.length !== val.length, `mtn=${mtn.length} val=${val.length}`);
  check('区別ON: 山に一点鎖線のdotが含まれる', mtn.some((s) => { const L = len2(sub2(s[1], s[0])); return L > 0 && L < 1.0; }));
  check('区別ON: 谷にはdotが無い(全部長さ3)', !val.some((s) => len2(sub2(s[1], s[0])) < 1.0));

  // 区別OFF: 山も谷も同じ破線
  const dashOff = { dashed: true, len: 3, gap: 2, distinguish: false };
  check('区別OFF: 山も谷と同じ破線', foldSegments(P, Q, dashOff, 'mountain').length === foldSegments(P, Q, dashOff, 'valley').length);
  // のりしろ付け根は常に破線（山扱いしない）
  check('付け根(tab)は破線', foldSegments(P, Q, dash, 'tab').every((s) => Math.abs(len2(sub2(s[1], s[0])) - 3) < 1e-6));
  // 実線モードは1本
  check('実線モード: 折り線は1本', foldSegments(P, Q, { dashed: false }, 'mountain').length === 1);

  // レーザーSVG全体: 立方体(全辺 山折り)で区別ONでもエラーなく生成できる
  const L = layoutOf(cube, { tabHeight: 5 });
  const svg = toLaserSVG(L, { dash })[0];
  check('レーザーSVG(区別ON)が生成される', svg.includes('id="score"') && svg.includes('<line'));
}

console.log(`\n=== 合計: ${pass} ok, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
