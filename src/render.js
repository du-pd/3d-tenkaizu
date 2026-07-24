// レイアウト結果を SVG 文字列 / DXF 文字列に変換する。
// mm単位で出力し、印刷スケールを保証する。
// 用途は2系統:
//   - papercraft: 山谷線・のりしろ・番号つきの手組み用
//   - laser: 切断線(CUT)と折り筋(SCORE)をレイヤー/色で分離したレーザー加工用

const XMLNS = 'http://www.w3.org/2000/svg';

function fmt(n) {
  return (Math.round(n * 1000) / 1000).toString();
}
function ptsAttr(pts) {
  return pts.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ');
}

// ---- SVG: ペーパークラフト用（山=一点鎖線, 谷=破線, 切=実線, のりしろ=細実線）----
export function toPaperSVG(layout, opts = {}) {
  const { pageW, pageH } = layout;
  const showNumbers = opts.numbers !== false;
  const svgs = [];
  layout.pages.forEach((page, pi) => {
    const body = [];
    for (const { pd, offset } of page.parts) {
      body.push(renderPartPaper(pd, offset, showNumbers));
    }
    svgs.push(wrapSVG(pageW, pageH, body.join('\n'), {
      title: `ペーパークラフト展開図 ページ${pi + 1}`,
    }));
  });
  return svgs;
}

function renderPartPaper(pd, offset, showNumbers) {
  const g = [];
  const T = (p) => [p[0] + offset[0], p[1] + offset[1]];
  // のりしろ: 外周3辺=細実線、付け根=折り線(細い破線)
  for (const tab of pd.tabs) {
    const o = tab.outer.map(T);
    g.push(`<polyline points="${ptsAttr([o[0], o[1], o[2], o[3]])}" fill="none" stroke="#888" stroke-width="0.2"/>`);
    const [b0, b1] = [T(tab.base[0]), T(tab.base[1])];
    g.push(`<line x1="${fmt(b0[0])}" y1="${fmt(b0[1])}" x2="${fmt(b1[0])}" y2="${fmt(b1[1])}" stroke="#aaa" stroke-width="0.2" stroke-dasharray="2,1.5"/>`);
  }
  // 切り線（太めの実線）
  for (const c of pd.cutLines) {
    const [p, q] = [T(c.p), T(c.q)];
    g.push(`<line x1="${fmt(p[0])}" y1="${fmt(p[1])}" x2="${fmt(q[0])}" y2="${fmt(q[1])}" stroke="#000" stroke-width="0.4"/>`);
  }
  // 折り線（山=一点鎖線 赤 / 谷=破線 青）
  for (const f of pd.foldLines) {
    const [p, q] = [T(f.p), T(f.q)];
    const style = f.mountain
      ? 'stroke="#d33" stroke-width="0.3" stroke-dasharray="4,1.5,1,1.5"'
      : 'stroke="#36c" stroke-width="0.3" stroke-dasharray="3,2"';
    g.push(`<line x1="${fmt(p[0])}" y1="${fmt(p[1])}" x2="${fmt(q[0])}" y2="${fmt(q[1])}" ${style}/>`);
  }
  if (showNumbers) {
    // 貼り合わせ辺番号
    for (const el of pd.edgeLabels) {
      const pos = T(el.pos);
      g.push(`<text x="${fmt(pos[0])}" y="${fmt(pos[1])}" font-size="2.2" fill="#0a0" text-anchor="middle" dominant-baseline="middle">${el.num}</text>`);
    }
    // パーツ番号
    for (const l of pd.labels) {
      const pos = T(l.pos);
      g.push(`<text x="${fmt(pos[0])}" y="${fmt(pos[1])}" font-size="4" fill="#333" text-anchor="middle" dominant-baseline="middle" font-weight="bold">${l.text}</text>`);
    }
  }
  return `<g>${g.join('')}</g>`;
}

// ---- SVG: レーザー加工用。CUT/SCORE をレイヤー(<g>)と色で分離 ----
// 既定色: 切断=赤(#FF0000), 折り筋(スコア)=青(#0000FF)。多くのレーザー機の慣習に合わせる。
export function toLaserSVG(layout, opts = {}) {
  const { pageW, pageH } = layout;
  const cutColor = opts.cutColor ?? '#FF0000';
  const scoreColor = opts.scoreColor ?? '#0000FF';
  const engrave = opts.engrave === true; // 番号を刻印レイヤーに出すか
  const scoreFolds = opts.scoreFolds !== false; // 折り線をスコアとして出すか
  const strokeW = opts.strokeWidth ?? 0.1; // ヘアライン相当
  const dash = opts.dash; // { dashed, len, gap } 破線設定（未指定=実線）

  const svgs = [];
  layout.pages.forEach((page, pi) => {
    const cut = [];
    const score = [];
    const mark = [];
    // スコア線を出力（破線なら実際の線分に分割）
    const emitScore = (p, q) => {
      for (const [a, b] of scoreSegments(p, q, dash)) score.push(lineEl(a, b, scoreColor, strokeW));
    };
    for (const { pd, offset } of page.parts) {
      const T = (p) => [p[0] + offset[0], p[1] + offset[1]];
      // 切断: 切り線 ＋ のりしろ外周3辺（付け根=底辺は切らない）
      for (const tab of pd.tabs) {
        const o = tab.outer.map(T);
        cut.push(polyline([o[0], o[1], o[2], o[3]], cutColor, strokeW, false));
      }
      for (const c of pd.cutLines) {
        cut.push(lineEl(T(c.p), T(c.q), cutColor, strokeW));
      }
      // スコア: 折り線 ＋ のりしろ付け根（低出力でスジ入れ）
      if (scoreFolds) {
        for (const f of pd.foldLines) emitScore(T(f.p), T(f.q));
        for (const tab of pd.tabs) emitScore(T(tab.base[0]), T(tab.base[1]));
      }
      // 刻印: 番号
      if (engrave) {
        for (const l of pd.labels) {
          const pos = T(l.pos);
          mark.push(`<text x="${fmt(pos[0])}" y="${fmt(pos[1])}" font-size="4" fill="#00A000" text-anchor="middle">${l.text}</text>`);
        }
      }
    }
    const layers = [
      `<g id="score" inkscape:label="SCORE" inkscape:groupmode="layer">${score.join('')}</g>`,
      engrave ? `<g id="engrave" inkscape:label="ENGRAVE" inkscape:groupmode="layer">${mark.join('')}</g>` : '',
      `<g id="cut" inkscape:label="CUT" inkscape:groupmode="layer">${cut.join('')}</g>`,
    ].filter(Boolean);
    svgs.push(wrapSVG(pageW, pageH, layers.join('\n'), {
      title: `レーザー展開図 ページ${pi + 1}`,
      inkscape: true,
    }));
  });
  return svgs;
}

function lineEl(p, q, color, w) {
  return `<line x1="${fmt(p[0])}" y1="${fmt(p[1])}" x2="${fmt(q[0])}" y2="${fmt(q[1])}" stroke="${color}" stroke-width="${w}" fill="none"/>`;
}
function polyline(pts, color, w, closed) {
  const tag = closed ? 'polygon' : 'polyline';
  return `<${tag} points="${ptsAttr(pts)}" fill="none" stroke="${color}" stroke-width="${w}"/>`;
}

// 線分 p-q を実際の破線（短い線分の列）に分割する。中央揃え・最低1本。
// 加工ソフトが stroke-dasharray を実線化してしまう問題を避けるため、
// SVG/DXF とも「本物の線分」に分割して出力する。
export function dashSegments(p, q, dashLen, gap) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return [];
  const ux = dx / L, uy = dy / L;
  const d = Math.max(0.1, dashLen), g = Math.max(0, gap);
  if (L <= d) return [[[p[0], p[1]], [q[0], q[1]]]]; // 短辺は1本の破線（全長）
  const period = d + g;
  const k = Math.max(1, Math.floor((L + g) / period)); // 破線本数
  const used = k * d + (k - 1) * g;
  const start = (L - used) / 2; // パターンを中央揃え
  const segs = [];
  for (let i = 0; i < k; i++) {
    const s = start + i * period, e = s + d;
    segs.push([[p[0] + ux * s, p[1] + uy * s], [p[0] + ux * e, p[1] + uy * e]]);
  }
  return segs;
}

// スコア線の分割: dash 指定があれば破線分割、なければ実線1本。
export function scoreSegments(p, q, dash) {
  if (dash && dash.dashed) return dashSegments(p, q, dash.len ?? 3, dash.gap ?? 2);
  return [[[p[0], p[1]], [q[0], q[1]]]];
}

function wrapSVG(w, h, body, meta = {}) {
  const inks = meta.inkscape
    ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${XMLNS}"${inks} width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" version="1.1">
<title>${meta.title || '展開図'}</title>
${body}
</svg>`;
}

// ---- DXF (R12 / AC1009 ASCII): レーザー/CAD向け。レイヤー CUT / SCORE に分離 ----
// SVGはY下向き、DXFはY上向きなので反転する。
// Illustrator のDXF読み込みは要求が厳しいので、$ACADVER・LTYPE/LAYER/STYLE
// テーブル・(空)BLOCKSセクション・図面範囲(EXTMIN/EXTMAX)まで含むフル構成にする。
// Rhino/LightBurn 等でも問題なく開ける。
export function toDXF(layout, opts = {}) {
  const flipY = (y) => layout.pageH - y; // 各ページ内で反転

  const dash = opts.dash; // { dashed, len, gap }
  // 1) まず全セグメントを集めて図面範囲を求める
  const segs = []; // { p, q, layer }
  const addScore = (p, q) => {
    for (const [a, b] of scoreSegments(p, q, dash)) segs.push({ p: a, q: b, layer: 'SCORE' });
  };
  layout.pages.forEach((page, pi) => {
    const pageOffX = pi * (layout.pageW + 20);
    for (const { pd, offset } of page.parts) {
      const T = (p) => [p[0] + offset[0] + pageOffX, flipY(p[1] + offset[1])];
      // のりしろ: 外周3辺=CUT、付け根=SCORE
      for (const tab of pd.tabs) {
        const o = tab.outer.map(T);
        segs.push({ p: o[0], q: o[1], layer: 'CUT' });
        segs.push({ p: o[1], q: o[2], layer: 'CUT' });
        segs.push({ p: o[2], q: o[3], layer: 'CUT' });
        if (opts.scoreFolds !== false) addScore(T(tab.base[0]), T(tab.base[1]));
      }
      for (const c of pd.cutLines) segs.push({ p: T(c.p), q: T(c.q), layer: 'CUT' });
      if (opts.scoreFolds !== false) {
        for (const f of pd.foldLines) addScore(T(f.p), T(f.q));
      }
    }
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    for (const pt of [s.p, s.q]) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] > maxY) maxY = pt[1];
    }
  }
  if (!isFinite(minX)) { minX = minY = 0; maxX = layout.pageW; maxY = layout.pageH; }

  const out = [];
  const push = (code, val) => { out.push(String(code)); out.push(String(val)); };

  // ---- HEADER ----
  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');   // R12。Illustratorが要求する
  push(9, '$INSUNITS'); push(70, 4);         // 4 = mm
  push(9, '$EXTMIN'); push(10, minX); push(20, minY); push(30, 0);
  push(9, '$EXTMAX'); push(10, maxX); push(20, maxY); push(30, 0);
  push(9, '$LIMMIN'); push(10, 0); push(20, 0);
  push(9, '$LIMMAX'); push(10, layout.pageW); push(20, layout.pageH);
  push(0, 'ENDSEC');

  // ---- TABLES: LTYPE, LAYER, STYLE ----
  push(0, 'SECTION'); push(2, 'TABLES');

  push(0, 'TABLE'); push(2, 'LTYPE'); push(70, 1);
  push(0, 'LTYPE'); push(2, 'CONTINUOUS'); push(70, 0);
  push(3, 'Solid line'); push(72, 65); push(73, 0); push(40, 0);
  push(0, 'ENDTAB');

  push(0, 'TABLE'); push(2, 'LAYER'); push(70, 2);
  layerDef(push, 'CUT', 1);   // 1 = red
  layerDef(push, 'SCORE', 5); // 5 = blue
  push(0, 'ENDTAB');

  push(0, 'TABLE'); push(2, 'STYLE'); push(70, 1);
  push(0, 'STYLE'); push(2, 'STANDARD'); push(70, 0);
  push(40, 0); push(41, 1); push(50, 0); push(71, 0); push(42, 2.5);
  push(3, 'txt'); push(4, '');
  push(0, 'ENDTAB');

  push(0, 'ENDSEC');

  // ---- BLOCKS（空でも必須。Illustrator対策）----
  push(0, 'SECTION'); push(2, 'BLOCKS');
  push(0, 'ENDSEC');

  // ---- ENTITIES ----
  push(0, 'SECTION'); push(2, 'ENTITIES');
  for (const s of segs) dxfLine(push, s.p, s.q, s.layer);
  push(0, 'ENDSEC');

  push(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

function layerDef(push, name, color) {
  push(0, 'LAYER'); push(2, name); push(70, 0); push(62, color); push(6, 'CONTINUOUS');
}
function dxfLine(push, p, q, layer) {
  push(0, 'LINE'); push(8, layer); push(6, 'CONTINUOUS'); push(62, 256); // 256 = ByLayer
  push(10, p[0]); push(20, p[1]); push(30, 0);
  push(11, q[0]); push(21, q[1]); push(31, 0);
}
