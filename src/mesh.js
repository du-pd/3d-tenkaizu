// 溶接済みメッシュから、面・辺の隣接テーブルを作り、
// 穴/非多様体を検出し、同一平面の隣接三角形をポリゴンにマージする。
import { sub, cross, dot, normalize, len, add, scale } from './vec.js';

const edgeKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

export function faceNormal(vertices, idx) {
  // idx: 面を構成する頂点インデックス列（3以上）
  // Newell法で法線を計算（凸凹・多角形に強い）
  let nx = 0,
    ny = 0,
    nz = 0;
  for (let i = 0; i < idx.length; i++) {
    const c = vertices[idx[i]];
    const n = vertices[idx[(i + 1) % idx.length]];
    nx += (c[1] - n[1]) * (c[2] + n[2]);
    ny += (c[2] - n[2]) * (c[0] + n[0]);
    nz += (c[0] - n[0]) * (c[1] + n[1]);
  }
  return normalize([nx, ny, nz]);
}

// 三角形メッシュから隣接情報を構築
export function buildTriMesh(vertices, triangles) {
  const faces = triangles.map((t) => ({
    verts: t.slice(),
    normal: faceNormal(vertices, t),
  }));

  // 辺 -> それに接する面インデックスのリスト
  const edgeMap = new Map();
  triangles.forEach((t, fi) => {
    for (let i = 0; i < 3; i++) {
      const a = t[i];
      const b = t[(i + 1) % 3];
      const k = edgeKey(a, b);
      if (!edgeMap.has(k)) edgeMap.set(k, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      edgeMap.get(k).faces.push(fi);
    }
  });

  let boundary = 0; // 穴（1面にしか接しない辺）
  let nonManifold = 0; // 3面以上に接する辺
  for (const e of edgeMap.values()) {
    if (e.faces.length === 1) boundary++;
    else if (e.faces.length > 2) nonManifold++;
  }

  return { vertices, faces, edgeMap, stats: { boundary, nonManifold } };
}

// 2つの隣接面の二面角情報を計算する。
// 戻り値: { angle: 平坦(180度)からのずれ[rad], mountain: bool }
// 凸辺(立方体の辺のように外側に折れる)を山折り(mountain=true)とする。
// 判定: 面2の遠方頂点を面1平面に投影した符号付き距離が負なら凸(山)。
export function dihedral(vertices, face1, face2, ea, eb) {
  const n1 = face1.normal;
  const n2 = face2.normal;
  let c = dot(n1, n2);
  c = Math.max(-1, Math.min(1, c));
  const angle = Math.acos(c); // 法線同士の角 = 平坦からのずれ

  // 面2の、共有辺に含まれない頂点を1つ選ぶ
  let far = null;
  for (const v of face2.verts) {
    if (v !== ea && v !== eb) {
      far = v;
      break;
    }
  }
  if (far === null) return { angle, mountain: true };
  const signed = dot(sub(vertices[far], vertices[ea]), n1);
  const mountain = signed < 0; // 平面より裏側 = 凸 = 山折り
  return { angle, mountain };
}

// --- 同一平面の隣接三角形をマージしてポリゴン面にする ---
// angleTol: これ以下の二面角ずれ(rad)を「同一平面」とみなす。
export function mergeCoplanar(mesh, angleTol = 1e-3) {
  const { vertices, faces, edgeMap } = mesh;
  const nF = faces.length;

  // Union-Find
  const parent = new Array(nF).fill(0).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // 二面角がほぼ0かつ法線が同じ向きの隣接三角形をマージ対象とする
  for (const e of edgeMap.values()) {
    if (e.faces.length !== 2) continue;
    const [f1, f2] = e.faces;
    const n1 = faces[f1].normal;
    const n2 = faces[f2].normal;
    if (dot(n1, n2) > Math.cos(angleTol)) {
      union(f1, f2);
    }
  }

  // グループごとに三角形を集める
  const groups = new Map();
  for (let i = 0; i < nF; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const mergedFaces = [];
  for (const [, trisIdx] of groups) {
    if (trisIdx.length === 1) {
      const f = faces[trisIdx[0]];
      mergedFaces.push({ verts: f.verts.slice(), normal: f.normal.slice(), tris: [trisIdx[0]] });
      continue;
    }
    const loop = buildOutline(faces, trisIdx);
    if (loop === null) {
      // 輪郭が単純ループにならない（穴あき等）→ マージせず個別に残す
      for (const ti of trisIdx) {
        const f = faces[ti];
        mergedFaces.push({ verts: f.verts.slice(), normal: f.normal.slice(), tris: [ti] });
      }
    } else {
      // 代表法線はグループ内三角形の面積加重平均
      let nrm = [0, 0, 0];
      for (const ti of trisIdx) {
        const f = faces[ti];
        const a = vertices[f.verts[0]];
        const b = vertices[f.verts[1]];
        const c = vertices[f.verts[2]];
        const cr = cross(sub(b, a), sub(c, a));
        nrm = add(nrm, cr); // cross の長さ = 2*面積
      }
      mergedFaces.push({ verts: loop, normal: normalize(nrm), tris: trisIdx.slice() });
    }
  }

  return rebuildPolyMesh(vertices, mergedFaces);
}

// 三角形グループの外周を単一ループとして取り出す。無理なら null。
function buildOutline(faces, trisIdx) {
  // 有向辺の出現回数を数える。内部辺は逆向きペアで相殺される。
  const dirCount = new Map();
  const key = (a, b) => a + '>' + b;
  for (const ti of trisIdx) {
    const v = faces[ti].verts;
    for (let i = 0; i < 3; i++) {
      const a = v[i],
        b = v[(i + 1) % 3];
      const k = key(a, b);
      dirCount.set(k, (dirCount.get(k) || 0) + 1);
    }
  }
  // 境界有向辺 = 逆向きが存在しないもの
  const nextOf = new Map();
  for (const [k, cnt] of dirCount) {
    const [a, b] = k.split('>').map(Number);
    const rev = key(b, a);
    if (!dirCount.has(rev)) {
      if (nextOf.has(a)) return null; // 分岐 = 単純ループでない
      nextOf.set(a, b);
    } else if (cnt !== 1) {
      // 同一有向辺が複数回 = 非単純
      return null;
    }
  }
  if (nextOf.size === 0) return null;
  // ループを辿る
  const start = nextOf.keys().next().value;
  const loop = [start];
  let cur = nextOf.get(start);
  let guard = 0;
  while (cur !== start) {
    loop.push(cur);
    cur = nextOf.get(cur);
    if (cur === undefined) return null;
    if (++guard > nextOf.size + 1) return null;
  }
  if (loop.length !== nextOf.size) return null; // 全境界辺を1ループで消化していない
  return loop;
}

// マージ済みポリゴン面から隣接テーブルを再構築
function rebuildPolyMesh(vertices, mergedFaces) {
  const edgeMap = new Map();
  mergedFaces.forEach((f, fi) => {
    const v = f.verts;
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const b = v[(i + 1) % v.length];
      const k = edgeKey(a, b);
      if (!edgeMap.has(k))
        edgeMap.set(k, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
      edgeMap.get(k).faces.push(fi);
    }
  });
  let boundary = 0,
    nonManifold = 0;
  for (const e of edgeMap.values()) {
    if (e.faces.length === 1) boundary++;
    else if (e.faces.length > 2) nonManifold++;
  }
  return {
    vertices,
    faces: mergedFaces,
    edgeMap,
    stats: { boundary, nonManifold },
  };
}
