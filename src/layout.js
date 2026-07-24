// 展開結果から、のりしろ・折線/切線セグメント・番号ラベルを生成し、
// A4への簡易ビンパッキングでページ配置する。
import { sub2, add2, scale2, normalize2, perp2, dot2, len2 } from './vec.js';

// パーツ単位で描画データを構築する。座標は「そのパーツのローカル(min原点)」に正規化。
export function buildLayout(mesh, unfold, opts = {}) {
  const tabHeight = opts.tabHeight ?? 5; // mm
  const tabAngle = (opts.tabAngle ?? 45) * (Math.PI / 180);
  const addTabs = opts.tabs !== false;
  const { faces, edgeMap } = mesh;
  const { facePart, parts, foldEdges, cutEdges } = unfold;
  // 実寸スケール（例: 高さ150mm指定）を座標へ反映
  const s = opts.scale ?? 1;
  const placed = unfold.placed.map((coords) =>
    coords ? coords.map((p) => [p[0] * s, p[1] * s]) : coords
  );

  const foldSet = new Set(foldEdges.map((e) => e.key));
  const foldInfo = new Map(foldEdges.map((e) => [e.key, e]));

  // 切り線に通し番号を振る（貼り合わせ相手が分かるように）
  const cutNumber = new Map();
  let cn = 1;
  for (const ce of cutEdges) cutNumber.set(ce.key, cn++);

  // セグメント取得: 辺(a,b) を面fiの2D上のセグメントとして返す。
  // 注意: 必ず独立コピーを返す。placed への参照を共有すると、
  // 平行移動時に同じ頂点が複数回動いてしまう（辺は頂点を共有するため）。
  function seg(fi, a, b) {
    const f = faces[fi];
    const ia = f.verts.indexOf(a);
    const ib = f.verts.indexOf(b);
    return [placed[fi][ia].slice(), placed[fi][ib].slice()];
  }

  const partData = parts.map((part) => ({
    index: part.index,
    faces: part.faces.slice(),
    polys: part.faces.map((fi) => ({ face: fi, coords: placed[fi].map((p) => p.slice()) })),
    foldLines: [],
    cutLines: [],
    tabs: [],
    labels: [], // パーツ番号など
    edgeLabels: [], // 切り辺の突き合わせ番号
  }));
  const partOf = (fi) => partData[facePart[fi]];

  // 折り線: 木として使った辺（1本だけ描画）
  for (const fe of foldEdges) {
    const fi = fe.faces[0];
    const [p, q] = seg(fi, fe.a, fe.b);
    partOf(fi).foldLines.push({ p, q, mountain: fe.mountain, key: fe.key });
  }

  // 切り線: 各隣接面の境界セグメントを個別に描く（=貼り合わせ位置）
  for (const ce of cutEdges) {
    const num = cutNumber.get(ce.key);
    ce.faces.forEach((fi, side) => {
      const [p, q] = seg(fi, ce.a, ce.b);
      partOf(fi).cutLines.push({ p, q, key: ce.key, num });
      // 切り辺の番号ラベル（辺の中点）。pos は独立配列にする。
      const mid = scale2(add2(p, q), 0.5);
      partOf(fi).edgeLabels.push({ pos: mid, num });
      // のりしろ: 2面ある辺なら片側(side===0)だけに付ける
      if (addTabs && (ce.faces.length === 1 || side === 0)) {
        const tab = makeTab(p, q, placed[fi], tabHeight, tabAngle);
        if (tab) partOf(fi).tabs.push({ poly: tab, key: ce.key, num });
      }
    });
  }

  // パーツ番号ラベル位置＝面重心の平均
  for (const pd of partData) {
    let cx = 0, cy = 0, n = 0;
    for (const poly of pd.polys) {
      for (const c of poly.coords) { cx += c[0]; cy += c[1]; n++; }
    }
    pd.labels.push({ pos: [cx / n, cy / n], text: 'P' + (pd.index + 1), part: true });
  }

  // 各パーツをローカル原点へ正規化し、bboxを計算
  for (const pd of partData) {
    const b = partBBox(pd);
    const off = [-b.minX, -b.minY];
    translatePart(pd, off);
    pd.bbox = partBBox(pd);
  }

  // A4 パッキング
  const packed = packA4(partData, opts);
  return {
    pages: packed.pages, parts: partData, cutNumber,
    pageW: packed.pageW, pageH: packed.pageH, margin: packed.margin,
    overflow: packed.overflow, // A4に収まらないパーツがあるか
  };
}

// のりしろ台形を作る。base=(p,q)の外側(面の反対側)へ立てる。
function makeTab(p, q, faceCoords, height, angle) {
  const e = sub2(q, p);
  const L = len2(e);
  if (L < 1e-6) return null;
  const eh = normalize2(e);
  let d = perp2(eh); // 辺の法線
  // 面重心が d 側なら反転して外向きにする
  let cx = 0, cy = 0;
  for (const c of faceCoords) { cx += c[0]; cy += c[1]; }
  cx /= faceCoords.length; cy /= faceCoords.length;
  const toC = sub2([cx, cy], p);
  if (dot2(toC, d) > 0) d = scale2(d, -1);

  const h = Math.min(height, L * 0.45);
  const inset = Math.min(h / Math.tan(angle), L * 0.45);
  const p1 = add2(add2(p, scale2(d, h)), scale2(eh, inset));
  const p2 = add2(add2(q, scale2(d, h)), scale2(eh, -inset));
  return [p.slice(), p1, p2, q.slice()];
}

function partBBox(pd) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (pt) => {
    if (pt[0] < minX) minX = pt[0];
    if (pt[1] < minY) minY = pt[1];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] > maxY) maxY = pt[1];
  };
  for (const poly of pd.polys) for (const c of poly.coords) acc(c);
  for (const t of pd.tabs) for (const c of t.poly) acc(c);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function translatePart(pd, off) {
  const t = (pt) => { pt[0] += off[0]; pt[1] += off[1]; };
  for (const poly of pd.polys) poly.coords.forEach(t);
  for (const f of pd.foldLines) { t(f.p); t(f.q); }
  for (const c of pd.cutLines) { t(c.p); t(c.q); }
  for (const tab of pd.tabs) tab.poly.forEach(t);
  for (const l of pd.labels) t(l.pos);
  for (const el of pd.edgeLabels) t(el.pos);
}

// A4 (210x297mm) にシェルフ法でパッキング。scaleは呼び出し側で適用済み前提。
function packA4(partData, opts) {
  const pageW = opts.pageW ?? 210;
  const pageH = opts.pageH ?? 297;
  const margin = opts.margin ?? 10;
  const gap = opts.gap ?? 5;
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;

  // 面積大きい順に置く
  const sorted = partData.slice().sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  let overflow = false;
  const pages = [];
  let page = { parts: [] };
  let x = margin, y = margin, shelfH = 0;
  const newPage = () => { pages.push(page); page = { parts: [] }; x = margin; y = margin; shelfH = 0; };

  for (const pd of sorted) {
    const w = pd.bbox.w, h = pd.bbox.h;
    if (w > usableW || h > usableH) {
      overflow = true; // 単体でページに収まらない（上位で警告）
    }
    if (x + w > margin + usableW && page.parts.length > 0) {
      // 次の棚へ
      x = margin;
      y += shelfH + gap;
      shelfH = 0;
    }
    if (y + h > margin + usableH && page.parts.length > 0) {
      newPage();
    }
    page.parts.push({ pd, offset: [x - pd.bbox.minX, y - pd.bbox.minY] });
    x += w + gap;
    if (h > shelfH) shelfH = h;
  }
  pages.push(page);
  return { pages, pageW, pageH, margin, overflow };
}
