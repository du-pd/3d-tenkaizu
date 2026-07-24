// 既知形状の三角形スープ生成（頂点はわざと分離させ、溶接工程を検証する）
import { sub, cross, dot } from '../src/vec.js';

// 面（頂点座標の配列, 3以上）を、法線が外向きになるよう三角形分割してpush
function pushFace(tris, center, poly) {
  // ファン分割
  for (let i = 1; i + 1 < poly.length; i++) {
    let a = poly[0], b = poly[i], c = poly[i + 1];
    // 外向きチェック: 面法線が中心から外を向くように
    const n = cross(sub(b, a), sub(c, a));
    const outward = sub(a, center);
    if (dot(n, outward) < 0) [b, c] = [c, b];
    tris.push([a.slice(), b.slice(), c.slice()]);
  }
}

export function cube(size = 20) {
  const s = size / 2;
  const v = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ];
  const faces = [
    [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4],
    [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4],
  ];
  const tris = [];
  for (const f of faces) pushFace(tris, [0, 0, 0], f.map((i) => v[i]));
  return tris;
}

export function tetrahedron(size = 20) {
  const a = size;
  const v = [
    [a, a, a], [a, -a, -a], [-a, a, -a], [-a, -a, a],
  ];
  const faces = [
    [0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2],
  ];
  const tris = [];
  for (const f of faces) pushFace(tris, [0, 0, 0], f.map((i) => v[i]));
  return tris;
}

export function octahedron(size = 20) {
  const a = size;
  const v = [
    [a, 0, 0], [-a, 0, 0], [0, a, 0], [0, -a, 0], [0, 0, a], [0, 0, -a],
  ];
  const faces = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  const tris = [];
  for (const f of faces) pushFace(tris, [0, 0, 0], f.map((i) => v[i]));
  return tris;
}

export function dodecahedron(size = 20) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const b = 1 / phi;
  const raw = [
    [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
    [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
    [0, b, phi], [0, b, -phi], [0, -b, phi], [0, -b, -phi],
    [b, phi, 0], [b, -phi, 0], [-b, phi, 0], [-b, -phi, 0],
    [phi, 0, b], [phi, 0, -b], [-phi, 0, b], [-phi, 0, -b],
  ];
  const v = raw.map((p) => p.map((c) => (c * size) / Math.sqrt(3)));
  // 12個の五角形面（頂点インデックス）
  const faces = [
    [0, 8, 10, 2, 16], [0, 16, 17, 1, 12], [0, 12, 14, 4, 8],
    [8, 4, 18, 6, 10], [10, 6, 15, 13, 2], [2, 13, 3, 17, 16],
    [17, 3, 11, 9, 1], [1, 9, 5, 14, 12], [14, 5, 19, 18, 4],
    [18, 19, 7, 15, 6], [15, 7, 11, 3, 13], [9, 11, 7, 19, 5],
  ];
  const tris = [];
  for (const f of faces) pushFace(tris, [0, 0, 0], f.map((i) => v[i]));
  return tris;
}
