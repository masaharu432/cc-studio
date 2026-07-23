# CC Studio: ui-zoom プラグイン 設計 (v0.5)

最終更新: 2026-07-23
（v0.5 の設定ランタイム連携は [2026-07-23-plugin-settings-number-design.md](2026-07-23-plugin-settings-number-design.md)）
関連: [plugins/README.md](../../plugins/README.md)（プラグイン規約）, keyboard-suppress.js / state-observer.js（全フレーム常駐の先例）

## 1. 背景と動機

スマホ縦画面では VS Code (code-server) の左アクティビティバー（CSS 48px の縦列）が横幅を大きく食い、
チャット・エディタの実効幅が狭い。「バーを ⋮ ピル程度まで細くしたい」が出発点。

縮小の経路は 4 つ検討し、最初の 3 つは不成立:

1. **`window.zoomLevel` 設定** — デスクトップ版（Electron）専用。zoom 系は `vs/workbench/electron-browser/`
   層にのみ存在し、code-server の Web 版 workbench には経路自体が無い（実ソースで確認済み）。
2. **ブラウザ/ピンチズーム** — code-server の viewport meta が user-scalable=no で封じている。
3. **トップフレームへの CSS zoom 注入**（v0.1-v0.2）— 実機で 2 つの致命傷が判明し**廃止**:
   - VS Code は workbench 寸法を `getClientArea(body)` → **`window.innerWidth`（zoom 非補正）**で
     取るため、zoom で縮んだぶんのレイアウトが敷き直されず**右下に L 字の空白が残る**
     （素の HTML なら ICB が補正されて詰まることを headless で確認したが、workbench は詰まらない）。
   - 標準化 CSS zoom は `getBoundingClientRect`/イベント座標が**視覚座標**、`style.left` 等が
     **zoom 内ローカル座標**と分裂する（headless 実測: zoom 0.75 下で 100% 幅 div の gBCR=800 に
     対し body.clientWidth=1067）。VS Code は変換せずに使うため、メニュー・ホバー・ドラッグの
     位置決めが (1-Z) ぶんズレる。外側からは直せない。
4. **viewport meta の initial-scale 書き換え**（本設計・v0.3）— ピンチズーム相当の縮小。
   レイアウト幅が 1/Z 倍に広がり、`innerWidth`・イベント座標・style 座標が**全 API 一貫**で
   スケールするため、workbench は「少し大きい画面」として自然に敷き直す。空白もズレも原理的に
   起きない。**採用。**

ただし縮小は全体に等しく掛かるため、チャット文字も Z 倍に縮む。チャット等のコンテンツフレーム側で
逆倍率の CSS zoom を掛け戻して「外枠だけ縮小・チャット等倍」を実現する（§5.2）。

> **v0.1 の教訓（2026-07-22 headless Chromium で実証）**: 継承倍率を子フレームの
> `currentCSSZoom` で実測する方式は成立しない。縮小の視覚的継承は起きるが、`currentCSSZoom` は
> **同一ドキュメント内の実効値のみ**を返し、親由来のスケールを含まず 1 を返す。つまり縮小は
> **子フレーム内から観測不能**。v0.2 以降は実測をやめ、トップが倍率を postMessage で配布する。

## 2. 方式判断（検討した代替案）

- **`workbench.activityBar.location: "top"` / `"hidden"`（settings.json 1 行）** — 縦列自体を消せて
  コード不要だが、縦のアイコン列を維持したまま細くしたいという要望に合わず不採用（ユーザー判断）。
  プラグインが不調な場合の逃げ道としては常に有効。
- **アクティビティバー単体の CSS width 上書き / transform 縮小** — workbench のレイアウトは JS が
  インラインピクセルで敷くため、バーだけ縮めても隣が詰まらず隙間が残る。不採用。
- **VS Code 拡張機能** — Web 版に zoom 経路が無く（§1-1）、拡張 API に workbench DOM/CSS を触る
  手段も無い。ファイルパッチ型（vscode-custom-css 系）はサブモジュール不可侵の方針に反し、
  かつチャット webview には届かない。不採用（2026-07-23 調査）。
- **トップフレームへの CSS zoom**（v0.1-v0.2）— §1-3 の 2 つの実証により廃止。
- **viewport meta 書き換え**（本設計）— 全 API 一貫のスケール。アプリ側 1 行（§6.1）が前提。**採用。**
- **「バーだけ Z・他は完全 1x」の部分スケール** — 不可能と結論（v0.4 検討時）。VS Code は全パーツを
  JS の数値ピクセルで敷くため、グリッドの枠と中身の描画の倍率が食い違うと必ず「隙間」（枠だけ縮小）
  か「溢れ」（中身だけ逆 zoom。パーツ内部の title/content のインライン px が枠を超える）になる。
  一様スケール＋**フォントのみ等倍戻し**（§5.3）で代替する。

## 3. ゴール / 非ゴール

**ゴール (v0.4)**:
- トップフレームの viewport meta を initial-scale=Z（初期値 0.75）へ書き換え、workbench 全体を
  縮小して横幅を稼ぐ（レイアウト幅は 1/Z 倍に拡大）。
- チャット等のコンテンツフレームは逆倍率の CSS zoom で等倍へ戻し、文字サイズを保つ。
- ネイティブ UI（ツリー・タブ・ステータスバー等）は**フォントサイズのみ** 1/Z 倍へ戻し、
  ジオメトリ（バー幅・行高・余白）は縮小のまま可読性を保つ（§5.3）。
- ⚙ 設定でライブ ON/OFF（`ccstudio:setting`）。OFF で viewport 原文へ復元・補正も解除。

**非ゴール（当面・YAGNI）**:
- 倍率の GUI スライダー（設定ランタイム v1 は boolean のみ。倍率はファイル先頭定数＋版数 bump で調整）。
- アクティビティバー幅の個別制御・アイコン再配置。
- エディタ本文の文字サイズ補正（必要なら settings.json の `editor.fontSize` で行う。プラグイン非対象）。

## 4. アーキテクチャ

```
アプリ (ScreenFactory): settings.useWideViewPort = true   ← viewport meta を尊重させる土台
プラグイン: @all-frames true × @run-at document-start で全フレーム注入
  各インスタンスが自分の役割を判定:
    トップフレーム (window.top === window)
      → viewport meta の content を initial-scale=Z へ書き換え（OFF で原文復元）
      → 葉フレームからの倍率照会 (postMessage) に現在倍率を返信
    非トップ かつ 葉フレーム（自文書内に iframe を持たない）＝コンテンツフレーム
      → window.top へ倍率を照会し、返ってきた topZ の逆倍率 1/topZ の CSS zoom で等倍へ戻す
    非トップ かつ iframe を抱える中間ラッパーフレーム
      → 何もしない（継承のまま）
```

- フレーム判定は規約どおりクラス名非依存の**構造ルール**のみ。チャット・プレビュー等の webview
  コンテンツはすべて葉フレームなので一律等倍へ戻る（望ましい副作用として許容）。
- 中間フレームは「ロード時は空で後から iframe が入る」ことがあるため、葉判定は固定しない。
  自文書への iframe 出現を MutationObserver で監視し、iframe が現れたら自分は中間フレームだった
  として補正を解除する。

## 5. 動作の詳細

### 5.1 縮小の適用（トップ）
- `meta[name="viewport"]` の content を
  `width=device-width, initial-scale=Z, maximum-scale=Z, minimum-scale=Z, user-scalable=no`
  へ書き換える（ピンチ無効は維持）。初回書き換え前の原文を保持し、OFF で復元する。
- meta は document-start 時点では未パースのことがある → MutationObserver＋1s インターバルの tick で
  出現し次第書き換える（body パース前に書ければフラッシュは目立たない）。
- 書き換え後は `window.dispatchEvent(new Event('resize'))` を保険で一発（viewport 変更でブラウザ
  自身の resize も飛ぶが、workbench の再レイアウトを確実にする）。
- `Z` はファイル先頭の定数（初期値 0.75）。チューニングは版数 bump で行う。

### 5.2 逆倍率の適用（コンテンツフレーム）
- 縮小は**子フレーム内から観測できない**（§1 の教訓）ため、実測ではなく**トップからの配布**で知る:
  - 葉フレームは `window.top` へ照会 `{k:'cc-uz-q'}` を postMessage する（クロスオリジン可）。
  - トップは `e.source` へ現在倍率 `{k:'cc-uz-z', z: (enabled かつ 適用成功) ? Z : 1}` を返信する。
    適用成否は `innerWidth >= screen.width / Z * 0.9`（スケールが効けば innerWidth が 1/Z 倍に
    広がる）で判定。**旧アプリビルド（useWideViewPort 無し）では meta 書き換えが無視される**ため、
    このガードが無いと「縮小なしでチャットだけ 1/Z 倍に拡大」する事故になる。
  - 葉は受信した topZ から `1 / topZ` を自フレーム root の CSS zoom に設定 → 正味等倍。
    topZ=1（無効時）なら補正を除去する。
- 照会は force（1s インターバル・設定イベント）と未受信時のみ送る。DOM 変異のたびに送ると
  チャットのストリーミング中に postMessage が乱発するため、変異では送らない。
- 適用判定は「自分が掛けた記憶」ではなく**現在の style.zoom の実測**と比較する。webview の
  アプリ（Claude 拡張等）は起動時に html の style を上書きして補正を消すことがあり、記憶比較だと
  “適用済み”と誤認して二度と直らない（v0.4.1 までの実機バグ。チャット・セッション一覧が
  小さいままだった原因）。html 要素の style 属性は MutationObserver（葉のみ・単体監視）で
  即時再適用し、保険の 1s tick でも自己修復する。
- トップが先・子が後にロードされる順序（iframe は親文書が作る）なので、document-start 注入なら
  照会時点でトップの受信リスナは常に武装済み。返信が来ない間は補正しない（誤って拡大しない）。
- 補正 zoom を掛けた葉では `window.innerWidth/innerHeight` を **zoom 後の座標系へ上書き**する
  （clientWidth 等は zoom 換算値なのに innerWidth だけ生値のままという不整合を解消）。
  innerWidth 基準で fixed 要素を置くアプリ JS が画面外へはみ出すのを防ぐ（v0.5.2）。
  defineProperty は document.open を跨いでも window に生き残る。
- **vw/vh 単位は CSS zoom の影響を受けない**（既知のギャップ）。viewport 単位でレイアウトする
  全画面オーバーレイ（Claude の画像プレビュー: 90vw/90vh の中央寄せ＋コンテナ右上角の ×）は
  補正 zoom 下で可視域より大きく組まれ、× が画面外へ押し出され「閉じられない」実害が出た
  （v0.5.2 まで。CDP 実測: × 右端 380px vs 可視 331px）。v0.5.3 でオーバーレイ
  `[class*="previewOverlay"]` に逆 zoom を注入し、内部を「補正なし」と同じ座標系へ戻して解消
  （正味 1 倍。実物で × 画面内復帰とクリックで閉じるまで確認）。クラス名依存の限定逸脱 2 例目
  （CSS-module の安定接頭辞のみ・失敗は現状維持側）。

### 5.3 ネイティブ UI のフォント等倍戻し（トップ）
- ネイティブ UI はフレームでないため逆 zoom は使えない（§2 の部分スケール不可）。ジオメトリは
  縮小のまま、`<style id="cc-uz-font">` を注入して**フォントサイズだけ** 1/Z 倍へ上書きする:
  - `.monaco-workbench { font-size: 実測値/Z !important }` — 既定 13px。
  - `.monaco-workbench .part > .content { font-size: 実測値/Z !important }` — 既定 13px の明示
    再指定。**ツリー・タブはここから継承**しており root だけでは届かない（v0.4.0 の不具合。
    稼働中の code-server 4.126.0 に CDP で注入して実測特定・修正確認。サブモジュールの版と
    生きているサーバの版は別物なので、カスケード検証は必ず実物に対して行うこと）。
  - `.monaco-workbench .part.statusbar { font-size: 実測値/Z !important }` — 明示 12px のため個別。
- なお「workbench UI のフォントサイズ設定」は VS Code に存在しない（editor.fontSize は
  エディタ本文のみ・window.zoomLevel は Electron 専用）ため、settings.json では代替できない。
- 原値は**上書き前に実測**してキャッシュ（VS Code 側の原値変更に追従。実測できるまで適用しない）。
- 実測値には Android WebView の textZoom（システムフォントスケール）が乗って見えるため、
  `font-size:100px` プローブ要素で倍率を実測して除いてから書く（除かないと二重適用で膨らむ。
  実機 uz-diag で ×1.15 の二重掛けを実測特定）。
- 戻し倍率は `FONT_TRIM / Z`。FONT_TRIM（初期 0.90）は「行高据え置きに対する詰まり感」を
  緩和する微調整定数（1.0 で完全等倍）。ユーザー実機フィードバックで決定。
- 適用条件は enabled かつ scaleApplied（§5.2 のガードと同じ）。OFF/未適用では style を除去。
- 行高は据え置きなので密度が上がる（13px/22px 行 → 17.3px/22px 行）。失敗モードは
  「文字が小さいまま」に倒れ、レイアウトを壊さない。
- **規約の限定逸脱**: ここだけ「クラス名非依存」を外し、VS Code 標準の `.monaco-workbench` /
  `.part.statusbar` を参照する（10 年来安定のセレクタ・失敗が無害側のため許容）。

### 5.4 ライブ ON/OFF
- `window.__ccPluginSettings['ui-zoom'].enabled`（既定 true）を読む。
- `ccstudio:setting` で enabled=false を受けたら、トップは viewport を原文へ復元。コンテンツ
  フレームは次回の照会への返信が z=1 になるので自然に補正解除（葉側は enabled を読まない:
  真実はトップ一元）。

## 6. プラグイン規約への適合とアプリ側前提

### 6.1 アプリ側の前提（1 行）
`ScreenFactory.newConfiguredWebView` に `settings.useWideViewPort = true` が必要（Android WebView の
既定 false は viewport meta の width/scale を無視する）。内蔵アセットと code-server の全ページは
`width=device-width, initial-scale=1` を宣言済みのため、この変更単体では挙動不変。

### 6.2 メタヘッダ

```
// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.3.0
// @description Shrink workbench chrome via viewport scale while keeping webview content at 1x.
// @description:ja workbench の外枠 UI を viewport スケールで縮小し、チャット等の文字サイズは等倍に保つ。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true 外枠 UI を縮小表示する
// @setting:ja  enabled 外枠 UI（アクティビティバー等）を縮小表示する
// ==/CCStudioPlugin==
```

- ネイティブブリッジ（`window.CCStudio.*`）は使わない。フレーム間通信は postMessage のみ
  （照会 `cc-uz-q` / 返信 `cc-uz-z` / HUD 中継 `cc-uz-hud`）。

## 7. 診断の作法

- focus-hud 共有バッファ `window.top.__ccStudioFocusLog` に `UZ` プレフィックスで積む:
  フレーム役割（top / leaf / wrapper）・適用スケール・配布された topZ・適用した補正倍率。
- 実機確認の最重要項目は「**viewport 書き換えで workbench が広いレイアウトに敷き直されるか**」
  （useWideViewPort が効いているかの確認を兼ねる）。`UZ top scale=0.75` の後に画面全体が
  縮小しつつ空白なく詰まっているかを目視で判定する。

## 8. エラー処理

- viewport meta が見つからない: 何もしない（次 tick で再試行。meta の無いページでは無効のまま）。
- 旧アプリビルド（useWideViewPort 無し）: meta 書き換えは無視され全体は等倍のまま。適用成否
  ガード（§5.2）で葉へ z=1 を返すため拡大事故は起きない。HUD に
  `UZ top: scale not applied (app useWideViewPort?)` を一度だけ出す。
- トップからの返信未達（プラグイン未注入・ロード順の谷間）: 補正スキップ（誤って拡大しない）。
- 適用の例外: try/catch でログのみ。UI は止めない。
- enabled=false: トップは原文復元、葉は返信 z=1 を受けて除去。

## 9. リスクと留意

- **useWideViewPort の副作用**: viewport meta の無いページは wide viewport（980px 相当）で
  レイアウトされる。内蔵アセット・code-server 各ページは全て meta 宣言済みで影響なし。
  外部 http ページは外部ブラウザで開く方針なので対象外。
- **チャット webview 内のポップアップ座標**: 葉フレームの CSS zoom 補正により、チャット文書内では
  gBCR（視覚座標）と style ピクセル（ローカル座標）の分裂が起きる。スラッシュコマンドの
  オートコンプリート等ポップアップ位置が (1-1/topZ) ぶんズレる可能性がある。実機で確認し、
  実害があれば倍率を 1 に近づけるか補正対象を絞る。
- **1px 罫線のにじみ**: 非整数倍率でボーダーが薄く/濃く見えることがある。実害が出れば 0.8 等へ。
- **アイコン類は小さいまま**: codicon 等は明示 px のフォント/サイズ指定なので §5.3 の上書きに
  乗らず Z 倍のまま（アクティビティバーを縮めたい意図とは合致。ツリーのファイルアイコン等も
  小さくなるのは許容）。
- **文字の切り詰め増**: フォントだけ戻すため 1 行に入る文字数は減り、省略記号が増える。
  特にサイドバー（セッション一覧等）は見かけ幅 Z 倍 × 文字等倍で顕著。**サイドバーの仕切りを
  一度右へドラッグして広げれば解消し、幅は保存される**（実機確認済み。全体が縮んでいるぶん
  広げてもチャットは以前より狭くならない）。README / session-list-readable の説明にも記載。
- **エディタ本文も縮む**: Monaco はインラインでフォントを敷くため §5.3 の対象外。チャット主体の
  運用では許容。気になる場合は `editor.fontSize` で補正。
- **rc-indicator 等トップ常駐 UI が縮む**: viewport スケールは全体に掛かるため、固定 px の
  オーバーレイも Z 倍になる。診断・小物 UI なので許容（実害があれば各プラグイン側で対応）。
- **rc-indicator ブランチとの合流**: `plugins/README.md` の本数更新が rc-indicator ブランチ
  （10 本化）と衝突し得るが、1 行の軽微な競合として合流時に解消する。

## 10. テスト

**ローカル（headless Chromium ハーネス・実施済み）**: 実プラグインを top→wrapper→leaf の 3 層
file:// ページへ読み込み、以下を確認（デスクトップ Chrome は viewport meta を無視するため
DOM 状態のみの検証。レンダリングは実機で確認する）:
- ON: viewport content が initial-scale=0.75 系へ書き換わる・top は CSS zoom を使わない・
  wrapper 非介入・leaf zoom=1.333（正味 1.0）。
- OFF: viewport 原文のまま・補正なし。
- ライブトグル OFF: viewport 原文へ復元・leaf 補正も ~1s で解除。

**実機スクリーン**:
- ON: 画面全体が縮小しつつ**空白なく**敷き直され、アクティビティバーが細く、チャット文字は等倍
  （`UZ top scale=0.75` / `UZ leaf topZ=0.750 comp=1.333` をログで確認）。
- コンテキストメニュー・ホバーがタップ位置どおりに出る（CSS zoom 時代のズレが無いこと）。
- サイドバー/パネルの開閉・境界ドラッグが正常。チャットのスラッシュコマンド補完の位置（§9）。
- OFF（⚙ ライブトグル）: 即座に等倍へ復帰。チャットが拡大表示にならない（過剰補正なし）。
- リロード後も設定どおりの状態で立ち上がる。

## 11. ファイル構成（cc-studio リポ）

```
plugins/ui-zoom.js               # 本体（v0.3.0）
plugins/README.md                # 本数を 9→10 に更新
app/src/main/java/app/ccstudio/ScreenFactory.kt   # useWideViewPort = true（§6.1）
docs/specs/2026-07-22-ui-zoom-plugin-design.md    # 本書
```

## 12. 実機検証結果 (2026-07-23, v0.5.1)

- viewport スケール: レイアウト幅 384→512 CSS px・表示 0.75 倍・空白なし（uz-diag 実測）。
- フォント等倍戻し: textZoom(×1.15) 除去後、書き込み 17.33px → computed 19.93px → 見かけ基準一致。
  最終的にユーザー調整で FONT 系既定 0.90 に決定。
- webview 等倍戻し: Claude チャット・セッション一覧・入力欄とも追従。v0.5.1 の
  document.open 対策（§5.2 の再武装）で ⚙ ライブ変更にもリアルタイム追従することを実機確認。
- ⚙ ステッパー（設定ランタイム v2）: shrink/sidebarFont/uiFont/claudeFont の 4 値とも
  リロード無しで反映・リロード後も保持・「デフォルトに戻す」動作を確認。
- 操作系: メニュー・サッシ・他プラグイン（rc-indicator の R タブ・⋮ ボタンの等倍復元）正常。
- 既知の運用ノウハウ: サイドバーは仕切りを一度広げる（§9）。
