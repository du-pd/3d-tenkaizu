// 展開エンジン:
//  1. 双対グラフを作り、二面角の小さい辺を優先的に残す全域木(MST)を張る
//  2. 木をたどり、共有辺を軸に子面を親の平面へ回転させて2Dへ展開
//  3. 重なりが出たら枝を切り、新しいパーツとして分割する
//  4. 山折り/谷折りを二面角の符号で判定する
import {
  sub, dot, len,
  sub2, add2, scale2, dot2, len2, normalize2, perp2, cross2,
} from './vec.js';
import { dihedral } from './mesh.js';

const edgeKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

// 面の3D頂点から、面内の等長2D座標(intrinsic)を作る。
// 距離を保つので、これを2D平面上で剛体移動(回転+平行移動+反転)すれば展開になる。
function intrinsicCoords(vertices, face) {
  const v = face.verts;
  const o = vertices[v[0]];
  let U = null;
  for (let i = 1; i < v.length; i++) {
    const d = sub(vertices[v[i]], o);
    if (len(d) > 1e-9) {
      U = normalize3(d);
      break;
    }
  }
  const N = face.normal;
  const V = normalize3(cross3(N, U));
  const coords = v.map((vi) => {
    const p = sub(vertices[vi], o);
    return [dot(p, U), dot(p, V)];
  });
  return coords; // 面の頂点順に対応した2D座標
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// 双対グラフの辺を作り、MST(二面角ずれが小さい辺を優先=木に含める)を張る。
export function buildSpanningTree(mesh) {
  const { vertices, faces, edgeMap } = mesh;
  const dualEdges = [];
  for (const [k, e] of edgeMap) {
    if (e.faces.length !== 2) continue; // 境界/非多様体はフォールドにできない
    const [f1, f2] = e.faces;
    const dih = dihedral(vertices, faces[f1], faces[f2], e.a, e.b);
    dualEdges.push({ key: k, f1, f2, ea: e.a, eb: e.b, angle: dih.angle, mountain: dih.mountain });
  }
  // 二面角ずれ(angle)昇順 = 平坦な折りを優先して木に残す
  dualEdges.sort((x, y) => x.angle - y.angle);

  const parent = new Array(faces.length).fill(0).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const treeEdges = [];
  const adj = new Map(); // 面 -> [{to, edge}]
  for (let i = 0; i < faces.length; i++) adj.set(i, []);

  for (const de of dualEdges) {
    const r1 = find(de.f1),
      r2 = find(de.f2);
    if (r1 !== r2) {
      parent[r1] = r2;
      treeEdges.push(de);
      adj.get(de.f1).push({ to: de.f2, edge: de });
      adj.get(de.f2).push({ to: de.f1, edge: de });
    }
  }
  return { dualEdges, treeEdges, adj };
}

// 木をたどって2D展開。重なりが出たら枝を切って新パーツにする。
// 戻り値: { parts, foldEdges, cutEdges }
export function unfoldMesh(mesh, tree, options = {}) {
  const { vertices, faces } = mesh;
  const { adj, treeEdges } = tree;
  const intrinsic = faces.map((f) => intrinsicCoords(vertices, f));

  // 展開結果: 面ごとの2D座標（グローバル座標）
  const placed = new Array(faces.length).fill(null); // [ [x,y]* ] 面頂点順
  const facePart = new Array(faces.length).fill(-1);
  const parts = []; // { faces:[fi...], polys: Map fi->coords }
  const usedTreeEdge = new Set(); // 実際にフォールドとして使った辺 key
  const cutTreeEdges = []; // 重なりで切った木辺

  // ルート集合（森）を巡る。全面を訪問するまでBFS。
  const visited = new Array(faces.length).fill(false);

  for (let root = 0; root < faces.length; root++) {
    if (visited[root]) continue;
    // 新パーツ開始
    const part = { faces: [], index: parts.length };
    parts.push(part);
    placeRoot(root, part);

    const queue = [root];
    visited[root] = true;
    while (queue.length) {
      const cur = queue.shift();
      for (const { to, edge } of adj.get(cur)) {
        if (visited[to]) continue;
        // cur は配置済み。to を cur の隣に展開してみる。
        const coords = placeChild(cur, to, edge);
        if (coords === null) {
          continue; // 木辺だが向きが取れない稀ケース。後続でルート化される。
        }
        if (overlaps(coords, to, part)) {
          // 重なり → この枝を切る（別パーツのルートにする）
          cutTreeEdges.push(edge);
          continue;
        }
        placed[to] = coords;
        facePart[to] = part.index;
        part.faces.push(to);
        usedTreeEdge.add(edge.key);
        visited[to] = true;
        queue.push(to);
      }
    }
  }

  function placeRoot(fi, part) {
    // ルートは intrinsic 座標をそのまま採用（後でパッキング時に平行移動）
    placed[fi] = intrinsic[fi].map((p) => p.slice());
    facePart[fi] = part.index;
    part.faces.push(fi);
  }

  // 親 pf（配置済み）に対して子 cf を共有辺で展開した2D座標を返す
  function placeChild(pf, cf, edge) {
    const ea = edge.ea,
      eb = edge.eb;
    // 親側の共有辺2D座標
    const pIa = faces[pf].verts.indexOf(ea);
    const pIb = faces[pf].verts.indexOf(eb);
    if (pIa < 0 || pIb < 0) return null;
    const A = placed[pf][pIa];
    const B = placed[pf][pIb];

    // 子側 intrinsic の共有辺
    const cIa = faces[cf].verts.indexOf(ea);
    const cIb = faces[cf].verts.indexOf(eb);
    if (cIa < 0 || cIb < 0) return null;
    const sA = intrinsic[cf][cIa];
    const sB = intrinsic[cf][cIb];

    // 子 intrinsic を、辺 sA->sB が A->B に一致する剛体変換で写す
    const mapped = mapEdge(intrinsic[cf], sA, sB, A, B, +1);

    // 親の重心が辺 A-B のどちら側かを見て、子を反対側に来るよう反転
    const pc = centroid(placed[pf]);
    const cc = centroid(mapped);
    const nrm = perp2(normalize2(sub2(B, A))); // 辺の法線
    const ps = Math.sign(dot2(sub2(pc, A), nrm));
    const cs = Math.sign(dot2(sub2(cc, A), nrm));
    if (ps === cs && ps !== 0) {
      // 同じ側 → 反転して反対側へ
      return mapEdge(intrinsic[cf], sA, sB, A, B, -1);
    }
    return mapped;
  }

  return finalizeUnfold(mesh, tree, {
    placed, facePart, parts, usedTreeEdge, cutTreeEdges,
  });

  // --- 内部ヘルパ ---
  function overlaps(coords, cf, part) {
    for (const other of part.faces) {
      if (other === cf) continue;
      if (polyOverlap(coords, placed[other])) return true;
    }
    return false;
  }
}

function centroid(poly) {
  let x = 0,
    y = 0;
  for (const p of poly) {
    x += p[0];
    y += p[1];
  }
  return [x / poly.length, y / poly.length];
}

// intrinsic 多角形を、辺 s0->s1 が t0->t1 に写るよう剛体移動する。
// flip=-1 なら辺に対して裏返す（反対側に配置するため）。
function mapEdge(poly, s0, s1, t0, t1, flip) {
  const ds = normalize2(sub2(s1, s0));
  const dsPerp = perp2(ds);
  const dt = normalize2(sub2(t1, t0));
  const dtPerp = perp2(dt);
  return poly.map((p) => {
    const rel = sub2(p, s0);
    const along = dot2(rel, ds);
    const perp = dot2(rel, dsPerp) * flip;
    return add2(add2(t0, scale2(dt, along)), scale2(dtPerp, perp));
  });
}

// --- 2Dポリゴンの重なり判定（単純多角形対応） ---
function polyOverlap(P, Q) {
  const eps = 1e-6;
  // 1) 辺同士が「まじわる」か（端点共有は除外）
  for (let i = 0; i < P.length; i++) {
    const a = P[i],
      b = P[(i + 1) % P.length];
    for (let j = 0; j < Q.length; j++) {
      const c = Q[j],
        d = Q[(j + 1) % Q.length];
      if (segProperIntersect(a, b, c, d, eps)) return true;
    }
  }
  // 2) 片方の（少し内側に縮めた）頂点が他方の内部にあるか＝包含
  const Pc = centroid(P);
  const Qc = centroid(Q);
  for (const p of P) {
    const pp = add2(p, scale2(sub2(Pc, p), 1e-3)); // 重心方向へ微小縮小
    if (pointInPoly(pp, Q)) return true;
  }
  for (const q of Q) {
    const qq = add2(q, scale2(sub2(Qc, q), 1e-3));
    if (pointInPoly(qq, P)) return true;
  }
  return false;
}

// 線分 ab と cd の「真の交差」（端点で触れるだけは除外）
function segProperIntersect(a, b, c, d, eps) {
  const d1 = cross2(sub2(b, a), sub2(c, a));
  const d2 = cross2(sub2(b, a), sub2(d, a));
  const d3 = cross2(sub2(d, c), sub2(a, c));
  const d4 = cross2(sub2(d, c), sub2(b, c));
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
    return true;
  }
  return false;
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1];
    const xj = poly[j][0],
      yj = poly[j][1];
    const intersect =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-30) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 展開結果を整形し、fold/cut 辺情報を付与する
function finalizeUnfold(mesh, tree, state) {
  const { faces, edgeMap, vertices } = mesh;
  const { placed, facePart, parts, usedTreeEdge, cutTreeEdges } = state;

  // 各パーツの多角形（面ごと）を格納
  for (const part of parts) {
    part.polys = part.faces.map((fi) => ({ face: fi, coords: placed[fi] }));
  }

  // 折り線（実際に木として使った辺）と、切り線（それ以外の全多様体辺）を分類
  const foldEdges = [];
  const cutEdges = [];
  for (const [k, e] of edgeMap) {
    if (e.faces.length !== 2) {
      // 元から境界の辺（穴）は切り線扱い
      cutEdges.push({ key: k, a: e.a, b: e.b, faces: e.faces.slice() });
      continue;
    }
    if (usedTreeEdge.has(k)) {
      const de = tree.dualEdges.find((d) => d.key === k);
      foldEdges.push({ key: k, a: e.a, b: e.b, faces: e.faces.slice(), mountain: de ? de.mountain : true, angle: de ? de.angle : 0 });
    } else {
      cutEdges.push({ key: k, a: e.a, b: e.b, faces: e.faces.slice() });
    }
  }

  return { parts, placed, facePart, foldEdges, cutEdges, cutTreeEdges };
}
