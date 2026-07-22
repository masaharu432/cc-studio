# CC Studio: ui-zoom プラグイン 設計 (v0.2)

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
25% 縮む。そこで **CSS zoom が iframe 内へ視覚的に継承される**（css-viewport 標準、Chromium 128+）こと
を利用し、チャット等のコンテンツフレーム側で逆倍率を掛け戻して「外枠だけ縮小・チャット等倍」を実現する。

> **v0.1 の教訓（2026-07-22 headless Chromium で実証）**: 継承倍率を子フレームの
> `currentCSSZoom` で実測する方式は成立しない。zoom の視覚的継承は起きる（iframe 内 400 CSS px が
> 親座標 302px に描画された）が、`currentCSSZoom` は**同一ドキュメント内の実効値のみ**を返し、
> 親ドキュメント由来の zoom を含まず 1 を返す。つまり継承は**子フレーム内から観測不能**。
> v0.2 は実測をやめ、トップフレームが倍率を postMessage で配布する方式に改めた。

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
      → 葉フレームからの倍率照会 (postMessage) に現在倍率を返信
    非トップ かつ 葉フレーム（自文書内に iframe を持たない）＝コンテンツフレーム
      → window.top へ倍率を照会し、返ってきた topZ の逆倍率 1/topZ で等倍へ戻す
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
- 継承倍率は**子フレーム内から観測できない**（§1 の教訓: `currentCSSZoom` はドキュメント境界を
  越えない）ため、実測ではなく**トップフレームからの配布**で知る:
  - 葉フレームは `window.top` へ照会 `{k:'cc-uz-q'}` を postMessage する（クロスオリジン可）。
  - トップは `e.source` へ現在倍率 `{k:'cc-uz-z', z: enabled ? Z : 1}` を返信する。
  - 葉は受信した topZ から `1 / topZ` を自フレーム root の zoom に設定 → 正味 topZ × (1/topZ) = 1.0。
    topZ=1（無効時）なら補正を除去する。
- 照会は tick ごと（初回 document-start＋1s インターバル）に送る。返信駆動で適用するため、
  トップのトグル変更にも ~1s で追従する。返信が来ない間は補正しない（誤って拡大しない）。
- トップが先・子が後にロードされる順序（iframe は親文書が作る）なので、document-start 注入なら
  照会時点でトップの受信リスナは常に武装済み。
- **前提**: zoom の iframe 内への視覚継承（Chromium 128+ の標準動作）。継承されない古い WebView では
  補正が「チャットだけ拡大」に化けるため、対象環境を Chromium 128+ とする（§9 参照）。

### 5.3 ライブ ON/OFF
- `window.__ccPluginSettings['ui-zoom'].enabled`（既定 true）を読む。
- `ccstudio:setting` で enabled=false を受けたら、トップは zoom を除去。コンテンツフレームは
  次回の照会への返信が z=1 になるので自然に補正解除（葉側は enabled を読まない: 真実はトップ一元）。

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

- ネイティブブリッジ（`window.CCStudio.*`）は使わない。フレーム間通信は postMessage のみ
  （照会 `cc-uz-q` / 返信 `cc-uz-z` / HUD 中継 `cc-uz-hud`）。

## 7. 診断の作法

- focus-hud 共有バッファ `window.top.__ccStudioFocusLog` に `UZ` プレフィックスで積む:
  フレーム役割（top / leaf / wrapper）・配布された topZ・適用した補正倍率。
- 実機確認の最重要項目は「**zoom の iframe 継承（視覚）が起きているか**」。これは API では観測
  できないので、`UZ leaf topZ=0.750 comp=1.333` が出た状態で**チャット文字が等倍に見えるか**を
  目視で判定する（拡大に見えたら継承なし環境 → enabled OFF で退避）。

## 8. エラー処理

- トップからの返信未達（プラグイン未注入・ロード順の谷間）: 補正スキップ（全体縮小として成立。
  誤って拡大する方向には倒れない）。
- zoom 適用の例外: try/catch でログのみ。UI は止めない。
- enabled=false: トップは除去、葉は返信 z=1 を受けて除去。

## 9. リスクと留意

- **WebView の Chromium 版数**: 標準化 zoom（レイアウト反映・iframe への視覚継承）は
  Chromium 128 (2024-08) 以降で、本設計はこれを**前提**にする（継承の有無は子から観測不能のため、
  実測フォールバックは組めない）。継承なし環境ではチャットだけ拡大に化けるので、目視で気づいたら
  enabled OFF で退避する。実機 WebView は 2026 年時点で十分新しい想定。
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

- ON: アクティビティバー・タブ・ステータスバーが縮小され、チャット文字は等倍のまま
  （`UZ leaf topZ=0.750 comp=1.333` をログで確認）。
- サイドバー/パネルの開閉・境界ドラッグが正常。rc-indicator 等の既存プラグイン操作が正常。
- OFF（⚙ ライブトグル）: 即座に全体が等倍へ復帰。チャットが拡大表示にならない（過剰補正なし）。
- リロード後も設定どおりの状態で立ち上がる（document-start 適用でフラッシュが目立たない）。
- ローカル Chromium ハーネス（`scripts/` 外・使い捨て）: top+leaf の 2 フレーム構成で
  正味倍率 ≒ 1.0（enabled 時）/ 補正なし（disabled 時）を headless で確認済みであること。

## 11. ファイル構成（cc-studio リポ）

```
plugins/ui-zoom.js               # 新規（本プラグイン本体）
plugins/README.md                # 本数を 9→10 に更新
docs/specs/2026-07-22-ui-zoom-plugin-design.md   # 本書
```
