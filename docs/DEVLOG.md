# 開発ログ / 引き継ぎメモ

> 次のセッション（毎回まっさらなコンテナ）が文脈を素早く取り戻すための記録。
> 作業は原則 main から派生ブランチを切って進め、PRでmainにマージ → 自動デプロイ。

## リンク
- 公開サイト（本番・全機能）: https://du-pd.github.io/3d-tenkaizu/
- 開発用マルチファイル版: https://du-pd.github.io/3d-tenkaizu/app/
- リポジトリ: https://github.com/du-pd/3d-tenkaizu
- お試しArtifact（非公開・作者のみ）: https://claude.ai/code/artifact/47f01f67-2687-4242-8184-0e8afcf48f4e

## 現在の状態（2026-07-24 時点）
- v0.1〜v0.3 + レーザー加工用ベクター出力(SVG/DXF) まで実装・マージ済み。
- GitHub Pages 公開済み（Source = GitHub Actions）。main への push で自動デプロイ。
- テスト: 幾何28 / 入出力19（DXFパーサ検証含む）/ UI（Playwright, コンソールエラー0）すべてパス。
- 未マージの変更なし・作業ツリーはクリーン。

## アーキテクチャ（ファイル早見表）
```
index.html          UI本体（サイドバー＋3Dプレビュー＋展開図プレビュー、印刷CSS）
src/
  vec.js            2D/3Dベクトル演算
  parse.js          STL(bin/ascii自動判定)/OBJ パース + 座標ハッシュ頂点溶接・破損検出
  mesh.js           隣接テーブル・穴/非多様体検出・平面マージ・二面角/山谷判定
  unfold.js         双対グラフ・全域木(MST,平坦辺優先)・共有辺回転で2D展開・重なり分割
  layout.js         のりしろ(台形/片側)・辺/パーツ番号・用紙(A4/A3/カスタム)パッキング・実寸/自動フィット
  render.js         ペーパーSVG / レーザーSVG(CUT/SCOREレイヤー) / DXF(フルR12)
  viewer3d.js       依存ゼロのCanvas 3Dプレビュー（DPR対応・ResizeObserver）
  samples.js        検証用サンプル形状（立方体/正四面体/正八面体/正十二面体）
  app.js            UI配線
test/               pipeline / io / ui テスト（shapes.js は samples.js を再エクスポート）
build.js            単一ファイル版を生成（dist/standalone.html=完全HTML, dist/artifact.html=ラッパー無し）
.github/workflows/pages.yml  main push で単一ファイル版をビルド→Pages自動デプロイ
```

## 開発コマンド
```
npm test          # 幾何 + 入出力テスト
npm run test:ui   # Playwrightブラウザテスト（要 http.server 8123 起動）
npm run build     # dist/standalone.html と dist/artifact.html を生成
npm run serve     # http://localhost:8123 で配信
```

## 重要な設計判断・注意
- 展開計算は自前実装。数学的正しさ（回転=等長変換、二面角の符号）を最優先。
- 凸辺=山折り(mountain)。展開の等長性はテストで検証済み。
- 3Dプレビューは Three.js ではなく自前Canvas（CDN不要・単一サイト完結を優先）。
- 印刷は「用紙に合わせる」オフ厳守の警告をUI常時表示。SVGはmm単位。
- DXFは Illustrator 互換のため フルR12(AC1009) 構成（LTYPE/LAYER/STYLE + 空BLOCKS + EXTMIN/MAX）。
  Rhino/LightBurn でも従来どおり開ける。

## 既知の制限
- 平面マージの外周抽出は単純ループ（穴なし面）前提。穴あき面はマージせず個別に残す。
- 重なり回避は貪欲法（重なったら枝を切って別パーツ化）。最適なパーツ数にはならない。
- 単一パーツが用紙を超える場合の自動分割は未対応（警告 or 印刷範囲に自動フィットで対応）。
- 減面処理は未実装。

## 完了（レビュー指摘の対応）
- [x] のりしろ干渉の解決: 同一パーツ本体面・他ののりしろと重なる場合は高さを詰めて回避、
      最小高さ未満は削除。件数をログ表示（tabStats）。※方式は corner-clip ではなく
      「短縮→削除」（glueしやすい台形を保つ・外部依存なし・重なりは完全に除去）。
- [x] のりしろ付け根=SCORE / 外周3辺=CUT に分離（レーザーで本体から切り離されない）。
- [x] 折り線の実線/破線設定。破線は SVG/DXF とも実際の短い線分に分割（mm指定・中央揃え・最低1本）。
- [x] テスト追加: 干渉不変条件・fitTabHeight・付け根線種・破線長/間隔（test/tabs.test.js）。

## 完了（レビュー中優先度の残り, PR #5）
- [x] スマホで3Dプレビュー高さ0 → `.panel.p3d { flex:0 0 360px }` で修正。UIテストで
      390px幅時の canvas 高さ>0 を検証。
- [x] CIで `npm test` を実行（pages.yml のビルド前）。テスト失敗時はデプロイされない。
- [x] アクセシビリティ: label の for/id 関連付け、ログ欄 `role=log aria-live=polite`、
      canvas に `role=img` と説明 aria-label。
- [x] レーザーモードの凡例を CUT / SCORE / ENGRAVE に切替（#legend2d をモードで更新）。
- [x] 大モデル対策（簡易）: 三角形数の警告（>4万で注意, >20万で強警告）＋処理時間ログ。
      ※Web Worker / 進捗バー / キャンセルは未実装（下記 TODO）。単一ファイル配信との両立に
      ビルド構成変更が要るため、実データで実際に遅い場合に着手する方針。
- [x] のりしろクリアランス(kerf)設定を追加（既定0.3mm。付け根は動かさず外周を控える）。

## 次にやる候補（TODO）
- [ ] 【要確認】新DXFが Illustrator 実機で開けるか（ユーザー確認待ち）。
- [ ] 大モデルの本格対策: Web Worker で展開計算をオフスレッド化＋進捗＋キャンセル
      （単一ファイル配信のためワーカーをBlobインライン化するビルド対応が必要）。
- [ ] v1.0: 3Dビューで辺クリック→「切る/繋ぐ」トグル→展開図リアルタイム更新の手動編集UI。
- [ ] 実データ（Rhino由来STL）での検証。
- [ ] 重なり分割の質改善（貪欲→パーツ数削減 or ユーザー指定のカット辺優先）。

## 履歴
- PR #1: 3D展開図メーカー v0.3 + レーザー出力 + GitHub Pages公開（merged）
- PR #2: DXFをIllustrator互換フルR12へ / 「印刷範囲に自動フィット」名称修正（merged）
- PR #3: 開発ログ追加（merged）
- PR #4: のりしろ干渉解決・付け根SCORE/外周CUT・折り線破線分割 + テスト（merged）
- PR #5: スマホ3D修正 / CIテスト / a11y / レーザー凡例 / 大モデル警告+時間 / クリアランス（merged）
