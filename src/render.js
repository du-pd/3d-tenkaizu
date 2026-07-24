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
  // のりしろ（細い実線）
  for (const tab of pd.tabs) {
    g.push(`<polygon points="${ptsAttr(tab.poly.map(T))}" fill="none" stroke="#888" stroke-width="0.2"/>`);
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

  const svgs = [];
  layout.pages.forEach((page, pi) => {
    const cut = [];
    const score = [];
    const mark = [];
    for (const { pd, offset } of page.parts) {
      const T = (p) => [p[0] + offset[0], p[1] + offset[1]];
      // 切断: パーツ外形（切り線）＋のりしろ外形
      for (const tab of pd.tabs) {
        // のりしろの外側3辺のみ切断（底辺=折り線側は切らない）
        const poly = tab.poly.map(T);
        cut.push(polyline([poly[0], poly[1], poly[2], poly[3]], cutColor, strokeW, false));
      }
      for (const c of pd.cutLines) {
        cut.push(lineEl(T(c.p), T(c.q), cutColor, strokeW));
      }
      // スコア: 折り線（山谷区別なし・低出力想定）
      if (scoreFolds) {
        for (const f of pd.foldLines) {
          score.push(lineEl(T(f.p), T(f.q), scoreColor, strokeW));
        }
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

// ---- DXF (R12 ASCII): レーザー/CAD向け。レイヤー CUT / SCORE に分離 ----
// SVGはY下向き、DXFはY上向きなので反転する。
export function toDXF(layout, opts = {}) {
  const { pageH } = layout;
  const flipY = (y) => pageH - y; // 各ページ内で反転
  const out = [];
  const push = (code, val) => { out.push(code); out.push(String(val)); };

  // ヘッダ + レイヤーテーブル
  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$INSUNITS'); push(70, 4); // 4 = mm
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'TABLES');
  push(0, 'TABLE'); push(2, 'LAYER'); push(70, 2);
  layerDef(push, 'CUT', 1);   // 1 = red
  layerDef(push, 'SCORE', 5); // 5 = blue
  push(0, 'ENDTAB');
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'ENTITIES');

  // 複数ページある場合はページごとにX方向へずらして1ファイルにまとめる
  layout.pages.forEach((page, pi) => {
    const pageOffX = pi * (layout.pageW + 20);
    for (const { pd, offset } of page.parts) {
      const T = (p) => [p[0] + offset[0] + pageOffX, flipY(p[1] + offset[1])];
      for (const tab of pd.tabs) {
        const poly = tab.poly.map(T);
        // のりしろ外側3辺
        dxfLine(push, poly[0], poly[1], 'CUT');
        dxfLine(push, poly[1], poly[2], 'CUT');
        dxfLine(push, poly[2], poly[3], 'CUT');
      }
      for (const c of pd.cutLines) dxfLine(push, T(c.p), T(c.q), 'CUT');
      if (opts.scoreFolds !== false) {
        for (const f of pd.foldLines) dxfLine(push, T(f.p), T(f.q), 'SCORE');
      }
    }
  });

  push(0, 'ENDSEC');
  push(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

function layerDef(push, name, color) {
  push(0, 'LAYER'); push(2, name); push(70, 0); push(62, color); push(6, 'CONTINUOUS');
}
function dxfLine(push, p, q, layer) {
  push(0, 'LINE'); push(8, layer);
  push(10, p[0]); push(20, p[1]); push(30, 0);
  push(11, q[0]); push(21, q[1]); push(31, 0);
}
