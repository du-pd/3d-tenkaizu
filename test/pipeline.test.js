// パイプライン検証: 既知形状で溶接・マージ・展開が数学的に正しいか確認する。
import { weldTriangleSoup } from '../src/parse.js';
import { buildTriMesh, mergeCoplanar } from '../src/mesh.js';
import { buildSpanningTree, unfoldMesh, unfoldMeshAsync } from '../src/unfold.js';
import { len2, sub2 } from '../src/vec.js';
import { cube, tetrahedron, octahedron, dodecahedron } from './shapes.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL- ${name} ${extra}`); }
}

function run(name, tris, expect) {
  console.log(`\n== ${name} ==`);
  const welded = weldTriangleSoup(tris);
  check(`${name}: 頂点溶接数`, welded.vertices.length === expect.verts,
    `got ${welded.vertices.length} want ${expect.verts}`);

  const tri = buildTriMesh(welded.vertices, welded.triangles);
  check(`${name}: 穴なし(boundary=0)`, tri.stats.boundary === 0, `boundary=${tri.stats.boundary}`);
  check(`${name}: 非多様体なし`, tri.stats.nonManifold === 0, `nm=${tri.stats.nonManifold}`);

  const merged = mergeCoplanar(tri);
  check(`${name}: 平面マージ後の面数`, merged.faces.length === expect.faces,
    `got ${merged.faces.length} want ${expect.faces}`);

  const tree = buildSpanningTree(merged);
  // 全域木の辺数 = 面数 - 連結成分数（凸多面体なら 面数-1）
  check(`${name}: 全域木辺数`, tree.treeEdges.length === merged.faces.length - 1,
    `got ${tree.treeEdges.length}`);

  const res = unfoldMesh(merged, tree);
  const totalFaces = res.parts.reduce((s, p) => s + p.faces.length, 0);
  check(`${name}: 全面が配置された`, totalFaces === merged.faces.length,
    `placed ${totalFaces}/${merged.faces.length}`);

  // 展開後、各共有辺の長さが3Dと一致するか（等長性 = 回転の正しさ）を1本確認
  check(`${name}: 展開の等長性`, checkIsometry(merged, res), '');

  console.log(`  -> parts=${res.parts.length}, fold=${res.foldEdges.length}, cut=${res.cutEdges.length}`);
  return { welded, merged, tree, res };
}

// 同一パーツ内で隣接する面が共有辺の2D長を保っているか
function checkIsometry(mesh, res) {
  const { faces, vertices } = mesh;
  for (const part of res.parts) {
    const placedSet = new Set(part.faces);
    for (const fi of part.faces) {
      const f = faces[fi];
      const coords = res.placed[fi];
      // 面の各辺の2D長 = 3D長 か
      for (let i = 0; i < f.verts.length; i++) {
        const a3 = vertices[f.verts[i]];
        const b3 = vertices[f.verts[(i + 1) % f.verts.length]];
        const d3 = Math.hypot(a3[0] - b3[0], a3[1] - b3[1], a3[2] - b3[2]);
        const d2 = len2(sub2(coords[i], coords[(i + 1) % coords.length]));
        if (Math.abs(d3 - d2) > 1e-6 * (d3 + 1)) return false;
      }
    }
  }
  return true;
}

async function checkAsyncMatches(name, merged, tree, res) {
  const asyncRes = await unfoldMeshAsync(merged, tree, { chunkSize: 2 });
  check(`${name}: 非同期展開でも全面が配置される`,
    asyncRes.parts.reduce((s, p) => s + p.faces.length, 0) === merged.faces.length);
  check(`${name}: 非同期展開でパーツ数が一致`, asyncRes.parts.length === res.parts.length,
    `async ${asyncRes.parts.length} sync ${res.parts.length}`);
  check(`${name}: 非同期展開で折り線数が一致`, asyncRes.foldEdges.length === res.foldEdges.length,
    `async ${asyncRes.foldEdges.length} sync ${res.foldEdges.length}`);
}

const cubeRes = run('立方体 (cube)', cube(), { verts: 8, faces: 6 });
const tetraRes = run('正四面体 (tetra)', tetrahedron(), { verts: 4, faces: 4 });
run('正八面体 (octa)', octahedron(), { verts: 6, faces: 8 });
run('正十二面体 (dodeca)', dodecahedron(), { verts: 20, faces: 12 });

await checkAsyncMatches('立方体 (cube)', cubeRes.merged, cubeRes.tree, cubeRes.res);
await checkAsyncMatches('正四面体 (tetra)', tetraRes.merged, tetraRes.tree, tetraRes.res);

{
  const forcedKey = cubeRes.tree.treeEdges[0].key;
  const forcedRes = unfoldMesh(cubeRes.merged, cubeRes.tree, { forcedCuts: new Set([forcedKey]) });
  check('強制カットでパーツ数が増える', forcedRes.parts.length > cubeRes.res.parts.length,
    `${forcedRes.parts.length} vs ${cubeRes.res.parts.length}`);
  check('強制カット辺が折り線から外れる', !forcedRes.foldEdges.some((e) => e.key === forcedKey));
  check('強制カット辺が切り線になる', forcedRes.cutEdges.some((e) => e.key === forcedKey));
}

console.log(`\n=== 合計: ${pass} ok, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
