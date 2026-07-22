# CC Studio: ui-zoom プラグイン 設計 (v0.1)

最終更新: 2026-07-22
関連: [plugins/README.md](../../plugins/README.md)（プラグイン規約）, keyboard-suppress.js / state-observer.js（全フレーム常駐の先例）

## 1. 背景と動機

スマホ縦画面では VS Code (code-server) の左アクティビティバー（CSS 48px の縦列）が横幅を大きく食い、
チャット・エディタの実効幅が狭い。「バーを ⋮ ピル程度まで細くしたい」が出発点。

縮小の経路は 3 つあり、前 2 つは使えない:

1. **`window.zoomLevel` 設定** — デスクトップ版（Electron）専用。code-server の Web 版では効かない
   （code-server 公式もブラウザズームを案内）。
2. **ブラウザ/ピンチズーム** — cc-studio の WebView は viewport 固定でピンチ縮小不可。
3. **CSS `zoom` の注入** — Chromium では `transform: scale()` と違い**レイアウトごと縮む**
   （空いた幅に他パーツが詰まる）。プラグインで注入可能。**採用。**

ただし zoom は全体に等しく掛かるため、バーを目標幅（約 2/3 = Z≒0.75）まで縮めるとチャット文字も
25% 縮む。そこで **CSS zoom が iframe 内へ継承される**（css-viewport 標準、Chromium 128+）ことを利用し、
チャット等のコンテンツフレーム側で逆倍率を掛け戻して「外枠だけ縮小・チャット等倍」を実現する。

## 2. 方式判断（検討した代替案）

- **`workbench.activityBar.location: "top"` / `"hidden"`（settings.json 1 行）** — 縦列自体を消せて
  コード不要だが、縦のアイコン列を維持したまま細くしたいという要望に合わず不採用（ユーザー判断）。
  プラグインが不調な場合の逃げ道としては常に有効。
- **アクティビティバー単体の CSS width 上書き / transform 縮小** — workbench のレイアウトは JS が
  インラインピクセルで敷くため、バーだけ縮めても隣が詰まらず隙間が残る。レイアウト JS と戦うことに
  なり脆い。不採用。
- **全体 CSS zoom＋コンテンツフレーム逆倍率**（本設計）— レイアウト整合は Chromium の zoom 実装に
  任せ、プラグインは倍率を宣言するだけ。**採用。**

## 3. ゴール / 非ゴール

**ゴール (v0.1)**:
- トップフレームに `zoom: Z`（初期値 0.75）を適用し、workbench の外枠 UI（アクティビティバー・タブ・
  サイドバー・ステータスバー）を縮小して横幅を稼ぐ。
- チャット等のコンテンツフレームは逆倍率で等倍へ戻し、文字サイズを保つ。
- ⚙ 設定でライブ ON/OFF（`ccstudio:setting`）。OFF で即座に等倍へ復帰。

**非ゴール（当面・YAGNI）**:
- 倍率の GUI スライダー（設定ランタイム v1 は boolean のみ。倍率はファイル先頭定数＋版数 bump で調整）。
- アクティビティバー幅の個別制御・アイコン再配置。
- エディタ本文の文字サイズ補正（必要なら settings.json の `editor.fontSize` で行う。プラグイン非対象）。

## 4. アーキテクチャ

```
@all-frames true × @run-at document-start で全フレーム注入
  各インスタンスが自分の役割を判定:
    トップフレーム (window.top === window)
      → documentElement.style.zoom = Z
    非トップ かつ 葉フレーム（自文書内に iframe を持たない）＝コンテンツフレーム
      → 継承 zoom を currentCSSZoom で実測し、逆倍率で等倍へ戻す
    非トップ かつ iframe を抱える中間ラッパーフレーム
      → 何もしない（継承のまま）
```

- フレーム判定は規約どおりクラス名非依存の**構造ルール**のみ。チャット・プレビュー等の webview
  コンテンツはすべて葉フレームなので一律等倍へ戻る（望ましい副作用として許容）。
- 中間フレームは「ロード時は空で後から iframe が入る」ことがあるため、葉判定は固定しない。
  自文書への iframe 出現を MutationObserver で監視し、iframe が現れたら自分は中間フレームだった
  として補正を解除する。

## 5. 動作の詳細

### 5.1 倍率の適用（トップ）
- `document.documentElement.style.zoom = String(Z)`。document-start 時点で documentElement は存在する
  ため即適用（フラッシュ防止）。
- `Z` はファイル先頭の定数（初期値 0.75）。チューニングは版数 bump で行う。

### 5.2 逆倍率の適用（コンテンツフレーム）
- 継承倍率は **`document.documentElement.currentCSSZoom`**（標準 API, Chromium 128+）で実測する。
  - 継承あり → `1 / currentCSSZoom` を自フレーム root の zoom に設定 → 正味 1.0。
  - 継承なし（値が 1）→ 何も掛からない。**自己校正なので二重補正・過剰拡大が起きない。**
  - `currentCSSZoom` 未実装の古い WebView → 補正しない（外枠ごと縮んだままの全体縮小として動く。
    誤って拡大する方向には倒れない）。
- 適用タイミング: 初回は document-start。トップの倍率変更（設定トグル）に追従するため、
  `ccstudio:setting` 受信時と低頻度インターバル（1s 目安）で `currentCSSZoom` を再読みし、
  変化があれば掛け直す。

### 5.3 ライブ ON/OFF
- `window.__ccPluginSettings['ui-zoom'].enabled`（既定 true）を読む。
- `ccstudio:setting` で enabled=false を受けたら、トップは zoom を除去、コンテンツフレームは
  次回の再読みで自然に補正解除（currentCSSZoom が 1 に戻るため）。

## 6. プラグイン規約への適合

```
// ==CCStudioPlugin==
// @name        ui-zoom
// @version     0.1.0
// @description Shrink workbench chrome via CSS zoom while keeping webview content at 1x.
// @description:ja workbench の外枠 UI を CSS zoom で縮小し、チャット等の文字サイズは等倍に保つ。
// @run-at      document-start
// @all-frames  true
// @setting     enabled boolean true 外枠 UI を縮小表示する
// @setting:ja  enabled 外枠 UI（アクティビティバー等）を縮小表示する
// ==/CCStudioPlugin==
```

- ネイティブブリッジ（`window.CCStudio.*`）は使わない。フレーム間通信も不要
  （倍率は同一ファイル内定数＋currentCSSZoom 実測で完結）。

## 7. 診断の作法

- focus-hud 共有バッファ `window.top.__ccStudioFocusLog` に `UZ` プレフィックスで積む:
  フレーム役割（top / leaf / wrapper）・適用倍率・currentCSSZoom 実測値・API 有無。
- 実機確認の最重要項目は「**zoom の iframe 継承が起きているか**」。leaf の currentCSSZoom ログで
  即断できるようにする。

## 8. エラー処理

- `currentCSSZoom` 未実装: 補正スキップ（全体縮小として成立）。
- zoom 適用の例外: try/catch でログのみ。UI は止めない。
- enabled=false: 何もしない / 適用済みなら除去。

## 9. リスクと留意

- **WebView の Chromium 版数**: 標準化 zoom（レイアウト反映・iframe 継承・currentCSSZoom）は
  Chromium 128 (2024-08) 以降。実機 WebView は 2026 年時点で十分新しい想定だが、DIAG で最初に確認する。
- **座標系**: 標準化 zoom ではイベント座標・getBoundingClientRect はフレーム内で一貫するため、
  サッシ操作・他プラグイン（rc-indicator の左端タブ、keyboard-suppress 等）への影響は原則無い見込み。
  パネル境界ドラッグと rc-indicator ボタンのタップ判定を実機で一度確認する。
- **トップフレーム常駐の HUD 類が縮む**: focus-hud の表示も Z 倍になる（診断用途なので許容）。
- **1px 罫線のにじみ**: 非整数倍率でボーダーが薄く/濃く見えることがある。倍率チューニングで実害が
  出れば 0.8 等のキリの良い値へ寄せる。
- **エディタ本文も縮む**: チャット主体の運用では許容。気になる場合は `editor.fontSize` で補正。
- **rc-indicator ブランチとの合流**: 本ブランチは origin/main 起点。`plugins/README.md` の本数更新が
  rc-indicator ブランチ（10 本化）と衝突し得るが、1 行の軽微な競合として合流時に解消する。

## 10. テスト（実機スクリーン）

- ON: アクティビティバー・タブ・ステータスバーが縮小され、チャット文字は等倍のまま（leaf の
  currentCSSZoom ≒ Z をログで確認）。
- サイドバー/パネルの開閉・境界ドラッグが正常。rc-indicator 等の既存プラグイン操作が正常。
- OFF（⚙ ライブトグル）: 即座に全体が等倍へ復帰。チャットが拡大表示にならない（過剰補正なし）。
- リロード後も設定どおりの状態で立ち上がる（document-start 適用でフラッシュが目立たない）。
- currentCSSZoom 未実装環境（もしあれば）: 全体縮小として動作しクラッシュしない。

## 11. ファイル構成（cc-studio リポ）

```
plugins/ui-zoom.js               # 新規（本プラグイン本体）
plugins/README.md                # 本数を 9→10 に更新
docs/specs/2026-07-22-ui-zoom-plugin-design.md   # 本書
```
