// STL / OBJ パーサ。三角形スープ or ポリゴンを読み、座標ハッシュで頂点をマージする。
// 学生データは頂点が分離している前提なので、溶接（weld）は必須工程。
import { sub, cross, normalize, len } from './vec.js';

// --- STL がバイナリかASCIIかを判定 ---
// ASCII は "solid" で始まることが多いが、バイナリでもヘッダに "solid" と書かれる罠がある。
// 三角形数×50+84 がファイルサイズと一致すればバイナリと判定する（確実）。
function isBinarySTL(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 84) return false;
  const nTri = dv.getUint32(80, true);
  const expected = 84 + nTri * 50;
  if (expected === buffer.byteLength) return true;
  // サイズが一致しなければ、先頭バイトがASCIIテキストらしいか見る
  const head = new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength));
  for (const b of head) {
    // 制御文字（タブ・改行・復帰以外）が含まれればバイナリ
    if (b < 9 || (b > 13 && b < 32)) return true;
  }
  return false;
}

function parseBinarySTL(buffer) {
  const dv = new DataView(buffer);
  const nTri = dv.getUint32(80, true);
  const need = 84 + nTri * 50;
  if (need > buffer.byteLength) {
    throw new Error(
      `バイナリSTLが壊れています: 宣言された三角形数 ${nTri} に対しファイルが短すぎます` +
        `（必要 ${need} bytes / 実際 ${buffer.byteLength} bytes）`
    );
  }
  const tris = [];
  let off = 84;
  for (let i = 0; i < nTri; i++) {
    off += 12; // 法線は読み飛ばす（後で再計算する）
    const v = [];
    for (let j = 0; j < 3; j++) {
      v.push([
        dv.getFloat32(off, true),
        dv.getFloat32(off + 4, true),
        dv.getFloat32(off + 8, true),
      ]);
      off += 12;
    }
    off += 2; // attribute byte count
    tris.push(v);
  }
  return tris;
}

function parseAsciiSTL(text) {
  const tris = [];
  const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
  let m;
  let cur = [];
  while ((m = re.exec(text)) !== null) {
    cur.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
    if (cur.length === 3) {
      tris.push(cur);
      cur = [];
    }
  }
  if (cur.length !== 0) {
    throw new Error('ASCII STL の頂点数が3の倍数になっていません（ファイル破損の可能性）');
  }
  if (tris.length === 0) {
    throw new Error('STL から三角形を1つも読み取れませんでした');
  }
  return tris;
}

// STL → 三角形スープ [[[x,y,z]*3], ...]
export function parseSTL(buffer) {
  // buffer: ArrayBuffer
  if (isBinarySTL(buffer)) {
    return parseBinarySTL(buffer);
  }
  const text = new TextDecoder().decode(buffer);
  return parseAsciiSTL(text);
}

// OBJ → { vertices, faces }（ポリゴン面をそのまま保持）
export function parseOBJ(text) {
  const verts = [];
  const faces = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('v ')) {
      const p = t.split(/\s+/);
      verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
    } else if (t.startsWith('f ')) {
      const p = t.split(/\s+/).slice(1);
      const idx = p.map((tok) => {
        // "v/vt/vn" 形式に対応。1始まり・負のインデックス両対応。
        let vi = parseInt(tok.split('/')[0], 10);
        if (vi < 0) vi = verts.length + vi + 1;
        return vi - 1;
      });
      if (idx.length >= 3) faces.push(idx);
    }
  }
  if (verts.length === 0 || faces.length === 0) {
    throw new Error('OBJ に頂点または面が見つかりませんでした');
  }
  return { vertices: verts, faces };
}

// --- 頂点溶接: 座標をグリッド量子化してハッシュ、同一座標の頂点をマージ ---
// tolerance はモデルのバウンディングボックス対角長に対する相対値。
export function weldTriangleSoup(tris, relTol = 1e-5) {
  // バウンディングボックスから絶対トレランスを決める
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) {
    for (const v of tri) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < mn[k]) mn[k] = v[k];
        if (v[k] > mx[k]) mx[k] = v[k];
      }
    }
  }
  const diag = len([mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]) || 1;
  const tol = diag * relTol;
  const invTol = 1 / Math.max(tol, 1e-12);

  const map = new Map(); // 量子化キー -> 頂点index
  const vertices = [];
  const key = (v) =>
    Math.round(v[0] * invTol) + '_' + Math.round(v[1] * invTol) + '_' + Math.round(v[2] * invTol);

  function getIndex(v) {
    const k = key(v);
    let idx = map.get(k);
    if (idx === undefined) {
      idx = vertices.length;
      vertices.push(v.slice());
      map.set(k, idx);
    }
    return idx;
  }

  const triangles = [];
  let degenerate = 0;
  for (const tri of tris) {
    const a = getIndex(tri[0]);
    const b = getIndex(tri[1]);
    const c = getIndex(tri[2]);
    if (a === b || b === c || a === c) {
      degenerate++;
      continue; // 面積ゼロの縮退三角形は捨てる
    }
    triangles.push([a, b, c]);
  }
  return { vertices, triangles, tol, degenerate };
}

// OBJ のポリゴン面を三角形に分割しつつ溶接（OBJは頂点共有済みだが念のため溶接）
export function weldPolygons(vertices, polyFaces, relTol = 1e-5) {
  // まず三角形スープに落として溶接パスを共通化する
  const tris = [];
  for (const f of polyFaces) {
    for (let i = 1; i + 1 < f.length; i++) {
      tris.push([vertices[f[0]], vertices[f[i]], vertices[f[i + 1]]]);
    }
  }
  return weldTriangleSoup(tris, relTol);
}
