// 展開結果から、のりしろ・折線/切線セグメント・番号ラベルを生成し、
// 用紙への簡易ビンパッキングでページ配置する。
//
// のりしろ(タブ)の扱い（レーザー加工を正しくするため重要）:
//   - 付け根(base) = 折り筋 → SCORE（切ってはいけない。切ると本体から外れる）
//   - 外周3辺(outer) = CUT
//   - 生成後、同一パーツの本体面や他ののりしろと重なる場合は高さを詰めて回避し、
//     最小高さを下回るものは削除する（件数はログ用に返す）。
import { sub2, add2, scale2, normalize2, perp2, dot2, len2, cross2 } from './vec.js';

export function buildLayout(mesh, unfold, opts = {}) {
  const tabHeight = opts.tabHeight ?? 5; // mm
  const tabAngle = (opts.tabAngle ?? 45) * (Math.PI / 180);
  const minTabHeight = opts.minTabHeight ?? 1.5; // mm これ未満に詰まったら削除
  const clearance = Math.max(0, opts.clearance ?? 0); // mm 加工余裕(kerf)
  const addTabs = opts.tabs !== false;
  const { faces } = mesh;
  const { facePart, parts, foldEdges, cutEdges } = unfold;
  // 実寸スケール（例: 高さ150mm指定）を座標へ反映
  const s = opts.scale ?? 1;
  const placed = unfold.placed.map((coords) =>
    coords ? coords.map((p) => [p[0] * s, p[1] * s]) : coords
  );

  // 切り線に通し番号を振る（貼り合わせ相手が分かるように）
  const cutNumber = new Map();
  let cn = 1;
  for (const ce of cutEdges) cutNumber.set(ce.key, cn++);

  // セグメント取得: 辺(a,b) を面fiの2D上のセグメントとして返す。必ず独立コピー。
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
    labels: [],
    edgeLabels: [],
  }));
  const partOf = (fi) => partData[facePart[fi]];

  // 折り線: 木として使った辺（1本だけ描画）
  for (const fe of foldEdges) {
    const fi = fe.faces[0];
    const [p, q] = seg(fi, fe.a, fe.b);
    partOf(fi).foldLines.push({ p, q, mountain: fe.mountain, key: fe.key });
  }

  // 切り線とのりしろ
  for (const ce of cutEdges) {
    const num = cutNumber.get(ce.key);
    ce.faces.forEach((fi, side) => {
      const [p, q] = seg(fi, ce.a, ce.b);
      const mid = scale2(add2(p, q), 0.5);
      partOf(fi).edgeLabels.push({ pos: mid, num });
      const tabSide = addTabs && (ce.faces.length === 1 || side === 0);
      if (tabSide) {
        // この辺はのりしろの付け根＝折り筋(SCORE)。切り線には入れない。
        // outer は後段の干渉解決で高さを確定してから作る。
        partOf(fi).tabs.push({
          base: [p, q], key: ce.key, num, fi,
          faceCoords: placed[fi], h0: tabHeight, angle: tabAngle,
        });
      } else {
        // 貼り合わせる相手側の辺＝CUT
        partOf(fi).cutLines.push({ p, q, key: ce.key, num });
      }
    });
  }

  // のりしろ干渉の解決（短縮／削除）
  let tabShortened = 0, tabDeleted = 0;
  for (const pd of partData) {
    const r = resolveTabInterference(pd, { minTabHeight, clearance });
    tabShortened += r.shortened;
    tabDeleted += r.deleted;
  }

  // パーツ番号ラベル位置＝面重心の平均
  for (const pd of partData) {
    let cx = 0, cy = 0, n = 0;
    for (const poly of pd.polys) for (const c of poly.coords) { cx += c[0]; cy += c[1]; n++; }
    pd.labels.push({ pos: [cx / n, cy / n], text: 'P' + (pd.index + 1), part: true });
  }

  // 各パーツをローカル原点へ正規化し、bboxを計算
  for (const pd of partData) {
    const b = partBBox(pd);
    translatePart(pd, [-b.minX, -b.minY]);
    pd.bbox = partBBox(pd);
  }

  const packed = packA4(partData, opts);
  return {
    pages: packed.pages, parts: partData, cutNumber,
    pageW: packed.pageW, pageH: packed.pageH, margin: packed.margin,
    overflow: packed.overflow,
    tabStats: { shortened: tabShortened, deleted: tabDeleted },
  };
}

// のりしろ台形の頂点列 [base0, outer1, outer2, base1] を作る。base の外側へ立てる。
export function makeTabPoly(p, q, faceCoords, height, angle) {
  const e = sub2(q, p);
  const L = len2(e);
  if (L < 1e-6) return null;
  const eh = normalize2(e);
  let d = perp2(eh);
  let cx = 0, cy = 0;
  for (const c of faceCoords) { cx += c[0]; cy += c[1]; }
  cx /= faceCoords.length; cy /= faceCoords.length;
  if (dot2(sub2([cx, cy], p), d) > 0) d = scale2(d, -1); // 面の外向きへ
  const h = Math.min(height, L * 0.45);
  const inset = Math.min(h / Math.tan(angle), L * 0.45);
  const p1 = add2(add2(p, scale2(d, h)), scale2(eh, inset));
  const p2 = add2(add2(q, scale2(d, h)), scale2(eh, -inset));
  return [p.slice(), p1, p2, q.slice()];
}

// 同一パーツ内で、のりしろが本体面や他ののりしろと重ならないよう高さを詰める。
// 詰めても最小高さ未満なら削除し、その辺はCUTに戻す。
function resolveTabInterference(pd, opts) {
  const minH = opts.minTabHeight;
  const clearance = opts.clearance ?? 0;
  const bodyPolys = pd.polys.map((p) => ({ fi: p.face, coords: p.coords }));
  const kept = [];
  let shortened = 0, deleted = 0;

  for (const tab of pd.tabs) {
    // 障害物: 自分の付く面を除く本体面 + すでに確定した他ののりしろ
    const obstacles = bodyPolys.filter((b) => b.fi !== tab.fi).map((b) => b.coords)
      .concat(kept.map((t) => t.outer));

    const h = fitTabHeight(tab.base, tab.faceCoords, obstacles,
      { h0: tab.h0, minH, angle: tab.angle });

    if (h != null) {
      // クリアランス分だけ控えて描く（焼け幅の余裕。付け根は動かさない）
      const drawH = Math.max(0.5, h - clearance);
      tab.outer = makeTabPoly(tab.base[0], tab.base[1], tab.faceCoords, drawH, tab.angle);
      tab.height = drawH;
      delete tab.faceCoords; // もう不要（後段の平行移動対象から外す）
      if (h < tab.h0 - 1e-6) shortened++;
      kept.push(tab);
    } else {
      // 削除 → 付け根の辺はCUTに戻す（貼り合わせ用）
      pd.cutLines.push({ p: tab.base[0].slice(), q: tab.base[1].slice(), key: tab.key, num: tab.num });
      deleted++;
    }
  }
  pd.tabs = kept;
  return { shortened, deleted };
}

// のりしろが障害物と重ならない最大高さを求める。minH 未満なら null（=削除）。
// 干渉は高さに単調（高いほど重なりやすい）なので二分探索できる。
export function fitTabHeight(base, faceCoords, obstacles, { h0, minH, angle }) {
  const ok = (h) => {
    if (h <= 1e-6) return true;
    const poly = makeTabPoly(base[0], base[1], faceCoords, h, angle);
    if (!poly) return false;
    for (const ob of obstacles) if (polyOverlap(poly, ob)) return false;
    return true;
  };
  let h;
  if (ok(h0)) h = h0;
  else {
    let lo = 0, hi = h0;
    for (let i = 0; i < 28; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    h = lo;
  }
  return h >= minH ? h : null;
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
  for (const t of pd.tabs) for (const c of t.outer) acc(c);
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function translatePart(pd, off) {
  const t = (pt) => { pt[0] += off[0]; pt[1] += off[1]; };
  for (const poly of pd.polys) poly.coords.forEach(t);
  for (const f of pd.foldLines) { t(f.p); t(f.q); }
  for (const c of pd.cutLines) { t(c.p); t(c.q); }
  for (const tab of pd.tabs) { tab.outer.forEach(t); tab.base.forEach(t); }
  for (const l of pd.labels) t(l.pos);
  for (const el of pd.edgeLabels) t(el.pos);
}

// --- 2Dポリゴンの重なり判定（頂点・辺の接触は重なりとみなさない） ---
export function polyOverlap(P, Q) {
  const eps = 1e-6;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    for (let j = 0; j < Q.length; j++) {
      const c = Q[j], d = Q[(j + 1) % Q.length];
      if (segProperIntersect(a, b, c, d, eps)) return true;
    }
  }
  const Pc = centroid2(P), Qc = centroid2(Q);
  for (const p of P) if (pointInPoly(add2(p, scale2(sub2(Pc, p), 1e-3)), Q)) return true;
  for (const q of Q) if (pointInPoly(add2(q, scale2(sub2(Qc, q), 1e-3)), P)) return true;
  return false;
}
function segProperIntersect(a, b, c, d, eps) {
  const d1 = cross2(sub2(b, a), sub2(c, a));
  const d2 = cross2(sub2(b, a), sub2(d, a));
  const d3 = cross2(sub2(d, c), sub2(a, c));
  const d4 = cross2(sub2(d, c), sub2(b, c));
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
         ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-30) + xi) inside = !inside;
  }
  return inside;
}
function centroid2(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

// 用紙にシェルフ法でパッキング。
function packA4(partData, opts) {
  const pageW = opts.pageW ?? 210;
  const pageH = opts.pageH ?? 297;
  const margin = opts.margin ?? 10;
  const gap = opts.gap ?? 5;
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;

  const sorted = partData.slice().sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  let overflow = false;
  const pages = [];
  let page = { parts: [] };
  let x = margin, y = margin, shelfH = 0;
  const newPage = () => { pages.push(page); page = { parts: [] }; x = margin; y = margin; shelfH = 0; };

  for (const pd of sorted) {
    const w = pd.bbox.w, h = pd.bbox.h;
    if (w > usableW || h > usableH) overflow = true;
    if (x + w > margin + usableW && page.parts.length > 0) { x = margin; y += shelfH + gap; shelfH = 0; }
    if (y + h > margin + usableH && page.parts.length > 0) newPage();
    page.parts.push({ pd, offset: [x - pd.bbox.minX, y - pd.bbox.minY] });
    x += w + gap;
    if (h > shelfH) shelfH = h;
  }
  pages.push(page);
  return { pages, pageW, pageH, margin, overflow };
}
