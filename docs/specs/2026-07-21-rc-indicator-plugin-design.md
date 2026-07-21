# CC Studio: rc-indicator プラグイン 設計 (v0.1)

最終更新: 2026-07-21
関連: [plugins/README.md](../../plugins/README.md)（プラグイン規約）,
`docs/specs/2026-07-20-rc-autoconnect-plugin-design.md`（RC まわりの実測知見・送信手順の先例）,
plugins/state-observer.js（busy 判定・フレーム作法の先例）, app/src/main/assets/bootstrap.js（⋮ ボタン）

## 1. 背景と動機

Remote Control (RC) が有効なセッションでは、claude-code webview の composer 直上に
**「Remote Control is active · Continue here, on your phone, or at claude.ai/code」バナーが常時表示**される
（RC 有効中は消えない・実機確認済み）。VS Code 拡張は PC の広い画面を前提に設計されているためこの帯でも
問題にならないが、**CC Studio はモバイルアプリ**であり、縦に狭い画面でこの帯が食う面積は無視できない。

ところが:
- バナーの **× ボタンは単なる「閉じる」ではなく RC 自体を切断**してしまう（実機確認済み）。
- `/remote-control` の再実行も接続済みではトグル＝切断になる。

つまり「RC は維持したまま表示だけ消す」公式の手段が無い。そこで:

1. **バナーを CSS で非表示**にする（DOM は残す＝RC 接続に無影響）。
2. バナーが担っていた「RC 有効の可視化」を、**画面端の小さな「R」ピル**で代替する。
3. ピルの**長押し**で **手動 RC オン/オフ**（`/remote-control` 送信）もできるようにする
   （⋮ ボタン直下にあるため、単タップだと誤爆しやすい）。

検知の要: **CSS で隠してもバナーは DOM に残る**ため、「バナー要素が DOM に存在するか」を
そのまま「このセッションで RC が有効か」の検知器として使える。非表示機能と検知機能が同一機構で済む。

## 2. 方式判断

- **単体プラグイン（rc-autoconnect とは分離）** — 自動接続を使わず手動で RC を張る運用でも
  バナー非表示・インジケーターは単独で欲しい。また rc-autoconnect は送信まわりの挙動が繊細
  （二重送信・再発火の修正履歴）で、無関係な機能の同居は検証範囲を無駄に広げる。**分離を採用。**
- **非表示＋インジケーター＋手動トグルは 1 本に統合** — 3 機能ともバナー検知を共有するため、
  プラグインは 1 本にし、機能ごとに `@setting` で ON/OFF する（すべてリロード不要のライブ反映）。
- ⋮ ボタン（`#ccstudio-menu-btn`）は **bootstrap.js がトップフレーム DOM に作る HTML 要素**であり、
  ネイティブ改修なしでプラグインから隣接 UI を置ける。⋮ ボタン自体はタップ＝switcher 起動に
  割り当て済みのため相乗りせず、**直下に独立したピルを新設**する。

## 3. ゴール / 非ゴール

**ゴール (v0.1)**:
- `hideBanner`: RC バナーを display:none で非表示。設定 OFF でその場で再表示（ライブ反映）。
- `indicator`: ⋮ ボタン直下に「R」ピルを表示し、RC 有効=グリーン / 無効=グレー を常時反映。
- `holdToggle`: ピルの**長押し（約 600ms・充填アニメーション付き）**で `/remote-control` を送信し
  手動オン/オフ。下書きあり・処理中は送信しない。単タップでは発火しない（誤爆防止）。

**非ゴール（YAGNI）**:
- 自動接続・再接続ロジック（rc-autoconnect の領分。両プラグインは独立に共存）。
- ネイティブ（Kotlin）側の変更、extension.js の改変。
- デスクトップ VS Code ネイティブ拡張単体対応。
- バナー以外の RC 関連表示（接続エラー等）の加工。

## 4. アーキテクチャ

```
@all-frames true × @run-at document-start で全フレーム注入
  composer フレーム（[aria-label="Message input"] 保持）:
    バナー検知（MutationObserver + ポーリング）
      ├ hideBanner=ON → display:none（目印属性を付与、OFF でその場復元）
      └ 存在有無 = RC 状態 → postMessage で top へ報告（変化時 + ハートビート・フレーム ID つき）
    top からのトグル依頼を受信 → ガード確認 → /remote-control 挿入・送信
  top フレーム:
    状態報告をフレーム別レジストリに集約（鮮度内に 1 つでも active があれば有効。
    last-writer-wins だと新規セッション時に新旧 composer フレームの相反報告でピルが点滅する
    ＝v0.1 の実害） → ⋮ ボタン直上に「R」ピルを描画・着色
    ピルの長押し完了 → 全フレームへトグル依頼をブロードキャスト
    ハートビート途絶（例: リロード・フレーム消滅）→ ピルを未接続表示に落とす
```

- composer フレームはクロスオリジンのため top へは `postMessage`（rc-autoconnect の HUD 中継と同型）。
- top → composer 方向は、`window.length` / 添字アクセスがクロスオリジンでも許可されることを利用し、
  フレームツリーを再帰走査して全フレームへ `postMessage` する（BroadcastChannel はオリジンを跨げないため不可）。

## 5. バナー検知（誤ヒット防止が最重要）

会話本文にも「Remote Control is active」は普通に出現し得るため、テキスト一致だけでは隠せない。

1. テキストノード走査（TreeWalker）で `Remote Control is active` を含むノードを探す。
2. **除外**: 祖先に `[data-testid*="message"]`（assistant-message / user message 等のトランスクリプト要素）を
   持つノードは無視する。
3. テキストノードから祖先を登り、**composer（`[aria-label="Message input"]`）を含まない最上位の要素**を
   バナー容器と判定する（composer を巻き込んで隠す事故を構造的に防ぐ）。
4. 容器が **`claude.ai/code` へのリンクまたは button 要素を内包**することを確認（バナーの構成要素。
   これを欠く一致は誤ヒットとして無視）。
5. 認定した容器に目印属性 `data-cc-ri-banner` を付与。hideBanner=ON なら `style.display='none'`。
   OFF への切替時は目印属性の要素の display を復元する。

RC 状態 = 「目印属性つき容器（または新規一致）が DOM に存在するか」。バナーは RC 有効中は
常時 DOM に残る（実機確認済み）ため、これがそのまま接続状態を表す。

**× ボタンには一切触れない**（クリック＝RC 切断のため）。本プラグインが発するのはスタイル変更のみ。

## 6. インジケーター UI（「R」ピル）

- top フレームの body 直下に固定配置。⋮ ボタン（`left:0; bottom:22%; height:84px`）の**直上**:
  `position:fixed; left:0; bottom:calc(22% + 92px); width:30px; height:34px;
  border-radius:0 10px 10px 0; z-index:2147483647;`
  （v0.1 の「直下」は composer 入力欄に近く、誤タップでキーボードが出る実害があったため上へ移動。）
- 「R」は**テキストノードではなく SVG ストローク**で描く（`stroke:currentColor` のパス）。
  テキストだと Android の長押しで文字選択が発動し、`pointercancel` が飛んで長押し判定ごと
  潰れる（v0.1 の実害: 長押しトグル不発の原因）。ピルには `touchstart` の preventDefault
  （passive:false）・`selectstart`/`contextmenu` 抑止も併せて張る。

**状態色**（既存の状態語彙との整合が最優先。⋮ ボタンは 青=通常/処理中パルス・赤=切断エラー を
既に使っており、青と赤系はピルに使えない）:
- **RC 有効 = グリーン** `linear-gradient(180deg,#34C77B,#1e9a58)`、文字は白・太字。
  控えめな緑グロー `box-shadow:2px 0 10px rgba(52,199,123,.45)`（⋮ ボタンの影の様式を踏襲）。
  緑=「外への生きたリンク」の普遍的信号で、既存の青・赤と一瞥で区別できる。
  （検討済み: Claude ブランドのコーラル #D97757 は「Claude へのリンク」の意味付けが立つが、
  小さいピルでは直上の赤=切断と誤読し得るため不採用。）
- **RC 無効 = フラットな暗グレー** `#3a4150`、文字 `#9aa3b2`。グラデーションと影を有効時専用に
  取っておくことで「フラット＝休眠」自体が情報になる。
- composer フレームからの報告が無い画面（チャット以外のスクリーン・未ロード）ではピルを**非表示**にする
  （ハートビートが `HEARTBEAT_MS × 3` 途絶したら非表示へ落とす）。
- state-observer も ⋮ ボタン本体の背景を塗る（busy パルス等）が、ピルは独立要素なので干渉しない。

## 7. 手動トグル（holdToggle）

> **v0.3 暫定**: 実機で長押しトグルが不発だったため、経路検証のあいだ**タップで発火**に変更中
> （押下でフィル点灯・pointerup で発火）。配信も「状態報告の `e.source` へ直接返信」を主route に
> 変更（再帰探索はフォールバック）。タップでの動作確認が取れ次第、本節の長押しへ戻す。

**長押しで発火**（単タップは無視）。⋮ ボタン直下という位置ゆえ、スクロール中や switcher を開こうと
した指が触れる誤爆が現実的にあり得るため、タップではなく長押しを採る。

- `pointerdown` から**約 600ms 押し続けると発火**。押下中はピル内でフィル（充填）が満ちていく
  アニメーションを表示し、「離せばキャンセル / 満ちれば実行」を目に見える形にする。
  途中で `pointerup` / `pointercancel` / 指が外れたらキャンセル（何も起きない）。
  `user-select:none` / `touch-action:none` / `-webkit-touch-callout:none` で長押しの
  テキスト選択・コンテキストメニューを抑止。`prefers-reduced-motion` ではフィル表示を省略し
  時間だけで判定。
- 発火すると top → 全フレームへトグル依頼をブロードキャスト。composer フレームだけが反応。
- **送信ガード**（すべて満たす場合のみ送信、不成立なら理由を top へ返しピルを短く明滅させて拒否を伝える）:
  1. composer が空（下書きがあると `/remote-control` 挿入で壊すため）。
  2. 処理中でない: `button[class*="sendButton"] [class*="stopIcon"]` が**不在**
     （処理中は送信ボタンが停止ボタンに化けるため、クリックすると応答を中断してしまう。
     state-observer の busy 判定と同一セレクタ）。
  3. 直近 3 秒以内にトグル送信していない（連打による二重トグル防止のデバウンス）。
- 送信手順は rc-autoconnect の実測確定手順を踏襲: focus → `document.execCommand('insertText')`
  （失敗時 InputEvent フォールバック）→ **送信ボタンのクリックのみ**（ボタン未検出時のみ Enter）。
- 接続済みで送れば切断、未接続で送れば接続（webview では確認プロンプト無し・実測）。
  ラベルの出し分けはせず、ピル色（現状態）が押した結果の意味を示す。
- rc-autoconnect との共存: 自動接続は新規セッション 1 回のみ（fired ガード）なので、本プラグインで
  手動切断しても再発火しない。競合しない。

## 8. プラグイン規約への適合

```
// ==CCStudioPlugin==
// @name        rc-indicator
// @version     0.1.0
// @description Hide the persistent "Remote Control is active" banner (RC stays on), and show a compact "R" pill under the ⋮ button instead; long-press the pill to toggle RC manually.
// @description:ja 常時表示の「Remote Control is active」バナーを非表示にし（RC は維持）、代わりに ⋮ ボタン直下の「R」ピルで状態表示。ピルの長押しで手動オン/オフ。
// @run-at      document-start
// @all-frames  true
// @setting     hideBanner boolean true RCバナーを隠す
// @setting:ja  hideBanner RCバナーを隠す（RC接続は維持）
// @setting     indicator boolean true 「R」ピルでRC状態を表示
// @setting:ja  indicator 「R」ピルでRC状態を表示
// @setting     holdToggle boolean true ピルの長押しでRCを手動オン/オフ
// @setting:ja  holdToggle ピルの長押しでRCを手動オン/オフ
// @setting     diag boolean false 診断ログを focus-hud に出す
// @setting:ja  diag 診断ログを focus-hud に出す
// ==/CCStudioPlugin==
```

- 3 機能とも `ccstudio:setting` でライブ反映（hideBanner OFF→復元、indicator OFF→ピル除去、
  holdToggle OFF→長押し無効化）。
- ネイティブブリッジ（`window.CCStudio.*`）は使わない（DOM 操作と postMessage のみ）。

## 9. 診断

- focus-hud 共有バッファ `window.top.__ccStudioFocusLog` に `RI` プレフィックスで積む（少量のため
  専用バッファは作らない）。クロスオリジンフレームからは rc-autoconnect と同型の top 中継で送る。
- 出す行: バナー認定/隠蔽/復元、RC 状態変化、トグル要求とガード結果。`diag` 既定 OFF
  （動作が安定したら見る必要が無いログのため。調査時のみ ON）。

## 10. エラー処理

- composer 不在フレーム: 検知・トグルとも即 return（正常）。
- バナー未検出: RC 無効として報告するだけ。例外は全て try/catch でログのみ、UI を止めない。
- top へ報告不達（postMessage 例外）: ピルはハートビート途絶で自然に非表示へ落ちる。

## 11. リスクと留意

- **バナー文言の言語**: 実機のバナーは英語固定を確認済みだが、拡張の更新でローカライズされた場合は
  検知文字列の追加が必要（DIAG で再確定する運用。クラス名依存よりは更新耐性が高い）。
- **クロスオリジンのフレーム走査**: `window[i].postMessage` はクロスオリジンでも仕様上許可されるが、
  webview の多層構成で全フレームに届くかは実機で確認する（届かない場合は各フレームから top への
  ポーリング型に切替える）。
- **誤ヒット**: §5 の 3 条件（トランスクリプト除外・composer 非内包・リンク/ボタン内包）で防ぐ。
  実機でチャット本文に該当文言を書いて隠れないことをテストする。
- **停止ボタン誤爆**: busy 中の送信ボタンは停止ボタン。§7 ガード 2 で構造的に回避。
- **将来の公式対応**: 拡張が「バナーを畳む/小型化する」公式 UI を持てば本プラグインの hideBanner は
  不要になる。その時は設定 OFF か削除で足りる。

## 12. テスト（実機スクリーン）

- hideBanner ON: RC 接続してもバナーが一瞬も見えない。RC はモバイルアプリ側から操作可能なまま。
- hideBanner を設定画面で OFF → その場でバナー再表示。ON → 再度消える（リロード不要）。
- indicator: RC 有効で「R」がグリーン、`/remote-control` で切断するとグレーに変わる。
  チャット以外のスクリーンではピルが出ない。リロード直後（RC 切断状態）はグレー表示。
- holdToggle: 未接続で長押し → RC 接続（バナーは出ず R がグリーン化）。接続中に長押し → 切断。
  単タップ・途中で離した長押しでは何も起きない。下書きがある時・応答生成中は長押し完了しても
  送信されない（明滅で拒否表示）。連続長押しで二重送信しない（3 秒デバウンス）。
- 誤ヒット: チャットで「Remote Control is active」を含む発言をしても本文が隠れない。
- rc-autoconnect 併用: 新規セッションで自動接続 → バナー非表示・R 着色まで一連で機能する。

## 13. ファイル構成（cc-studio リポ）

```
plugins/rc-indicator.js          # 新規（本プラグイン本体）
plugins/README.md                # 本数を 9→10 に更新
docs/specs/2026-07-21-rc-indicator-plugin-design.md   # 本書
```
