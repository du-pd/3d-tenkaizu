// 3D / 2D ベクトル演算ユーティリティ（依存なし・Node/ブラウザ両対応）
// 3D は [x,y,z]、2D は [x,y] の素の配列で表現する。

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a) {
  const l = len(a);
  if (l < 1e-12) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

// ---- 2D ----
export const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const scale2 = (a, s) => [a[0] * s, a[1] * s];
export const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len2 = (a) => Math.hypot(a[0], a[1]);
export const perp2 = (a) => [-a[1], a[0]]; // 90度回転（反時計回り）
export function normalize2(a) {
  const l = len2(a);
  if (l < 1e-12) return [0, 0];
  return [a[0] / l, a[1] / l];
}
// 2D 外積（z成分のみ）: 符号で左右・向きが分かる
export const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
