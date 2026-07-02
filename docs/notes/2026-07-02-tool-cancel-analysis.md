# 突発キャンセル解析 — 2026-07-02 の MainActivity 編集拒否事象

- 日付: 2026-07-02
- 種別: 調査メモ（[[2026-06-30-connection-tool-cancel]] の続報・証拠に基づく切り分け）
- きっかけ: CC Studio 越しのセッションで、MainActivity.kt の編集が
  `The user doesn't want to take this action` で弾かれた（本人操作ではない）。
  会話中に何度も出ている「突発キャンセル」の再発と見られる。

## 事象の時刻

Observer Log（アプリ内ビューア）より、拒否は `02:04:17.682 foreground` の直後に発生。
その直前は background/foreground が数秒周期で激しくフラッピングしていた:

```
02:02:32.155 background @cc-studio
02:02:38.285 foreground @cc-studio
02:02:44.711 background @cc-studio
02:02:48.217 foreground @cc-studio
02:03:19.717 background @cc-studio
02:03:22.967 foreground @cc-studio
02:03:32.118 background @cc-studio
02:03:45.383 foreground @cc-studio
02:04:01.750 background @cc-studio
02:04:08.522 foreground @cc-studio
02:04:16.718 background          ← ~1秒の背面化
02:04:17.682 foreground         ← ここで MainActivity 編集が拒否
```

## コードから分かった事実

### 1. CANCEL は検知されているが、永続ログに載らない（=最大のボトルネック）

- 検知: `plugins/state-observer.js:103-106` `detectCancel()` が本文の
  `"doesn't want to take this action"` を拾う。
- しかし CANCEL は `plugins/state-observer.js:222-227` で **hudLog / postMessage(cancel) にしか
  行かない**（focus-hud の一時バッファ。最大16行、リロードで消える）。
- 永続ログ／サーバアップロードへ届くのは `observerLog(busy, disc, matched)`
  （`plugins/state-observer.js:130-135`）のみで、**CANCEL は含まれない**。
- 結果、[[2026-06-30-connection-tool-cancel]] のフェーズ2が想定した
  「突発キャンセル時刻を近傍の keepalive failure / screen disconnected と突合する」が
  **現状は原理的に不可能**（CANCEL の時刻がダウンロード可能ログにもサーバ observer.jsonl にも残らない）。
  → これは謎ではなく、**埋めるべき計測ギャップ**。

### 2. 今回の窓では接続断の痕跡が無い

- Observer Log に `keepalive closed` / `keepalive failure` が窓内に**一つも無い**。
- `disconnected`（再接続トースト）状態も**一切出ていない**。
  検知は `plugins/state-observer.js:87-102` で `attempting to reconnect` /
  `cannot reconnect` トーストのみ拾う設計。トーストが出ていない＝可視の code-server 断は無し。
- → **接続瞬断由来（旧メモの見立て1）を支持する証拠は無い。**

### 3. keyboard-suppress の blur は今回の機構としては弱い

- `plugins/keyboard-suppress.js:72-83` の `suppressBox()` は
  `[role="textbox"][aria-multiline="true"]`（Claude composer）と `.monaco-editor` **だけ**を対象に blur する。
- 権限プロンプト／編集許可カードはこのどちらでもないため、blur が直接キャンセルを起こす経路は薄い。
- → 旧メモの見立て2「focus 抑制（keyboard-suppress の blur）由来」も主因としては弱い。

## 現時点の主仮説

**一時的な背面化（window blur）が、保留中のプロンプトをキャンセルさせている。**

- 機構: VS Code の確認 UI（QuickPick / inputBox / 拡張のプロンプト）は
  ウィンドウ／webview がフォーカスを失うと自動的に閉じる＝キャンセルされる挙動を持つ。
- CC Studio が一瞬 background になると WebView が blur し、保留中の権限プロンプトが
  自動 dismiss → `The user doesn't want to take this action` として Claude に届く。
- **接続断も plugin blur も不要**で、今回の証拠（断の痕跡なし＋直前の背面化フラッピング）と整合する。

補足の未解決点: なぜ 02:02〜02:04 に background/foreground が数秒周期でフラッピングするのか
（本人操作か、通知の割り込みか、アプリ側の挙動か）は未特定。これも主因の引き金候補。

## 追記（2回目・ユーザ指摘）: 「往復そのものが異常」

ユーザ観測の訂正:
- **通知洪水は無関係**（そこでキャンセルは出ない）。
- キャンセルが出るのは **AI が処理中 ＋ アプリが背面（本人が CC Studio を操作していない）** とき。

そして本質的な指摘: **本人が操作していないのに `background`/`foreground` が 1 秒間に何度も
（実測 `00:00:30.060 background` / `00:00:30.061 foreground` = 1ms 差）往復するのは、そもそもおかしい**。
人手のアプリ切替でこの周期は出ない → **何かがプログラム的に Activity ライフサイクルを叩いている**。

### コード確認の結果
- `MainActivity` 自身には往復を起こすループは無い（`onResume`/`onPause` は標準＋ログのみ、
  `recreate()` も連続 `moveTaskToBack` も無し）。
- → 往復は Activity 外の**一時的なオーバーレイ/フォーカス喪失**で `onPause→onResume` が瞬時に
  往復している疑い。
- **重要な計測欠陥**: 今のログは `onPause=background` としているが、`onPause` は
  「本当の背面化」と「一時ダイアログ/フォーカス喪失」の**両方**で発火する。つまりログの
  `background` は**本当の背面化とは限らない**。1ms 往復は後者（フォーカス喪失）の可能性が高い。

### 対応（計測の分離・実装済み）
`MainActivity` に以下を追加し、3系統を分けて記録:
- `onStart`→`start-visible` / `onStop`→`stop-hidden`（＝**本当の背面化**）
- `onWindowFocusChanged`→`winfocus`/`winblur`（＝**窓フォーカスの喪失/回復**）
- 既存 `onResume`/`onPause`→`foreground`/`background` は温存

これで次回、往復が **stop-hidden を伴う本当の背面化**なのか、**winblur だけの一時フォーカス喪失**なのかを
判別できる。突発キャンセルは後者（VS Code の確認 UI やターンが window blur で中断される）に相関する疑い。

## 確定解析（3回目・ソース逆引きによる機構の特定）

これまで推測だった「なぜ STOP メッセージが届くのか」を、**claude CLI バイナリと拡張の実コードから逆引き**して確定させた。

### 証拠1: メッセージの発生源は CLI（拡張ではない）

`~/.local/share/claude/versions/2.1.195`（CLI バイナリ）内:

```js
_N="[Request interrupted by user]",
Jv="[Request interrupted by user for tool use]",
uQ="The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
```

さらに同バイナリ内に**保留リクエストの一括 reject 処理**がある:

```js
this.inputClosed = !0;
for (let n of this.pendingRequests.values())
  n.reject(Error("Tool permission stream closed before response received"))
```

→ **UI との権限ストリーム（stream-json の制御チャネル）が閉じると、保留中の対話リクエスト
（can_use_tool 権限確認・AskUserQuestion 等のダイアログ）が全部 reject される**。
can_use_tool の reject は `uQ`＝「The user doesn't want to take this action…」としてターンに注入される。

### 証拠2: ストリームを閉じるのは「webview パネルの破棄」

`anthropic.claude-code-2.1.197` の `extension.js`:

```js
e.onDidDispose(() => {
  c.shutdown(),                 // ← CLI との通信を終了
  this.allComms.delete(c), this.webviews.delete(n);
  ... this.sessionPanels.delete(u), this.sessionStates.delete(u) ...
})
```

→ チャットの webview パネルが dispose されると拡張が `comms.shutdown()` を呼び、CLI 側で
`inputClosed` → 保留リクエスト一括 reject が発火する。

### 証拠3: 同一セッションで両方の顔を実測

この開発セッション自体（CC Studio 経由）で:
- AskUserQuestion が **`Tool permission stream closed before response received`** で失敗（reject の生文字列）
- Edit / Write が **`The user doesn't want to take this action`** で中断（can_use_tool reject の注入形）

= **同じ一つの機構の二つの現れ**。

### 証拠4: 引き金はアプリの背面死/再生成（ログ実測）

- `12:26:06 background` → `12:26:18 lifecycle: start`（**onCreate＝コールドスタート**）→ 全スクリーン再ロード
  → 直後に cancel 検知。= 背面でプロセスが殺され、復帰でワークベンチごと作り直された。
- `12:22:06〜12:24:06` の**2分背面**では `start` 無し（プロセス生存）なのにターン消滅
  → 背面中の WebView ソケット凍結→復帰時のワークベンチ再接続/再ロードでも webview は作り直される。
- 一方、新計測（winblur/stop-hidden 分離後）では **数十秒の背面ではターンが生存する例**も確認
  → 「背面＝即死」ではなく、**プロセス kill or ワークベンチ再ロードが起きた時だけ**死ぬ、と整合。

### 確定した因果チェーン

```
アプリ背面化
  → (a) Android がプロセス kill（復帰時 lifecycle: start）
    or (b) WebView ソケット凍結が長引き、復帰時にワークベンチ再ロード
  → チャット webview パネルが dispose（作り直し）
  → 拡張 onDidDispose → comms.shutdown()
  → CLI の権限ストリーム close → inputClosed
  → 保留中の対話リクエスト（権限確認/質問）を一括 reject
  → 「The user doesn't want to take this action right now. STOP …」がターンに注入
  = 突発キャンセル
```

### 旧仮説の判定

| 仮説 | 判定 |
|---|---|
| 接続瞬断（cc-notify WS）由来 | **否定**。native keepalive は別ソケットで、断は観測されていない。死ぬのは WebView 側のワークベンチ接続。 |
| keyboard-suppress の blur 由来 | **主因ではない**。機構はフォーカスではなく webview 破棄＋ストリーム切断。 |
| フォーカス喪失で VS Code プロンプトが自動 dismiss | **惜しいが不正確**。dismiss ではなく、webview 破棄→ストリーム close→CLI 側 reject。 |

### 対策の方向（トリガー潰しが本命）

1. **背面 kill / 凍結を防ぐ**: バッテリー最適化の除外（Samsung「スリープさせないアプリ」）、
   必要なら cc-web の無音オーディオ MediaSession キープアライブ資産の移植
   （`cc-web/cc-web-keepalive/` — ONE playing tab keeps all sockets alive の実証済み手法）。
2. **保留窓を減らす**: 対話リクエスト（権限確認）が pending のまま背面化するのが急所。
   bypass permissions の活用や、離席前にプロンプトを残さない運用で露出を下げる。
3. **観測は整備済み**: cancel 永続化＋重複除去＋lifecycle 3系統分離により、
   以後の発生は「start 伴う＝プロセス死」「stop-hidden のみ＝再ロード」を機械的に判別できる。

## 追補（4回目）: 「通知があるのに殺される」抜け穴の特定と対処

ユーザ質問「FGS（常駐通知）があれば基本killされないのでは？オーディオとは別機構？」への調査で
**FGS を素通りする具体的な抜け穴**をソースから特定した。

- WebView のレンダラは Android 8+ で**アプリと別のサンドボックスプロセス**。FGS はアプリ本体
  プロセスを守るが**レンダラは保護外**で、既定ポリシーは「非可視ならレンダラ優先度を放棄」＝
  背面では真っ先に kill 候補になる。
- さらに全 WebViewClient が **`onRenderProcessGone` 未実装**だった。Android の仕様では未処理の
  レンダラ死は**アプリ本体ごと強制終了**される。つまり: 背面→レンダラkill→アプリごと死
  →復帰コールドスタート→webview破棄→comms.shutdown()→突発キャンセル、という
  **FGS があっても成立する経路**が存在した。
- cc-web の無音オーディオはブラウザ（FGS を持てない）向けの代替であり、自アプリでは
  FGS＋レンダラ対策が本筋（機構は別物、という理解で正しい）。

対処（実装済み・APK 260702-1503）:
1. 全 WebViewClient を共通基底 `CcWebViewClient` に統一し `onRenderProcessGone` を処理。
   道連れクラッシュを防ぎ、`renderer-crash`/`renderer-killed` を永続ログへ記録して
   `recreate()` で全画面復旧（レンダラは全 WebView 共有のため個別復旧は不可）。
2. `setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, 非可視でも維持)` で
   背面でのレンダラ kill 自体を抑止（電池より生存性を優先）。

### 監視機構のチェック結果（renderer 事象を今のログ基盤で追えるか）

- **追える**: renderer-* はネイティブ側で記録（JS 凍結の影響を受けない）→ 同期 flush で
  ファイルに残ってから recreate → 60s 定期/復帰時アップロードで observer.jsonl へ到達
  → ログビューアで赤表示。以後「コールドスタートの犯人がレンダラか否か」を機械判定できる。
- **既知の限界（読み方の注意）**: cancel は本文文字列の存在検知のため、リロード
  （recreate 復旧・手動リロード含む）のたびに**過去の中断メッセージを再検知**しうる。
  ネイティブ 15s デデュープは直後のエコーのみ吸収。**`start`/`renderer-*` の直後に出る
  cancel 行はエコーの可能性あり**として読む。恒久対策（メッセージ単位のフィンガープリント）は
  必要になったら実装。

## 確定タイムライン（5回目・発生時刻の一次証拠つき）

別セッションのトランスクリプトから **キャンセルの正確な発生時刻＝16:03:05 JST** が判明
（switcher.html への Write が拒否された瞬間。Write 自体は数十秒前〜直前に開始）。
observer ログと突合した確定タイムライン:

```
15:48:20  busy @cc-studio            ← 別セッションのターンがサーバ側で実行中
15:49:04  stop-hidden                ← 背面化。以後ユーザは端末に触れていない
16:02〜03 （サーバ側で CLI が Write を発行 → 権限リクエストが UI チャネル待ちに）
16:03:05  ◀ キャンセル発生（背面化から 14.0 分後・復帰の 85 秒前）
16:04:30  start-visible              ← ユーザ復帰。ワークベンチ再ロード（idle/busy フラップ）
16:30:29  cancel 検知（＋16:32/16:34にも）← パネルを開いた時に DOM 検知が 27 分遅れで拾った
```

### この1件で確定したこと

1. **引き金はユーザ操作でも復帰時再ロードでもない**。端末未接触の背面中に、**サーバ側のタイムアウトで**
   webview セッションが破棄される（凍結した WebView のワークベンチソケットが死に、猶予期間の後に
   サーバがそのウィンドウのセッションを畳む → 拡張 onDidDispose → comms.shutdown() → CLI が
   保留中の can_use_tool を reject）。renderer-killed も start（プロセス死）も無し。
2. **ターン自体は背面中もサーバ側で走り続ける**。死ぬのは「UI チャネルが要る瞬間」＝ツール権限の
   確認が保留になったとき。対話リクエストを伴わないターンは背面中でも完走しうる（実測とも整合）。
3. **DOM 文字列検知の時刻は当てにならない**。発生 16:03:05 に対し検知は 16:30:29（パネルを開いた時）。
   発生時刻の一次証拠は**セッショントランスクリプト**（`~/.claude/projects/` 配下）にある。
4. 猶予時間の正確な定数は未特定（観測デルタは 7〜14 分超。ソケット死の検出タイミング＋グレースの
   合成なので端末状態に依存）。特定するにはサーバ側（code-server）のログが要る。

### 対策の優先順位（この確定を受けて更新）

1. **B: 背面中もワークベンチ接続を生かす**（本命）— ソケットを死なせなければ破棄もされない。
   cc-web の無音オーディオ MediaSession 資産の移植が最有力。レンダラ優先度維持（実装済み）は
   前提条件だが、それだけではソケット死→サーバ側破棄を防げないことが今回実証された。
2. **保留窓を減らす** — bypass permissions 等で「UI 待ちの権限リクエスト」自体を減らす。
3. **観測の格上げ** — DOM 検知は補助に格下げ。発生時刻の正確な収集は、サーバ側で
   `~/.claude/projects/*/**.jsonl` のトランスクリプトから拒否メッセージ（uQ）を走査して
   observer.jsonl と自動突合する方式を検討（正確・遅延なし・アプリ非依存）。

## 次の一手（優先度順）

1. **CANCEL を永続ログに載せる（最小・低リスク・推奨）**
   - `state-observer.js` が CANCEL を `observerLog` 経由で永続ログ／アップロードに書くよう修正。
   - 直前の lifecycle 遷移・keepalive・disconnected と時刻突合でき、**次回発生時に主因を断定**できる。
   - これで「CANCEL 直前に background があれば lifecycle 由来」「keepalive failure / disconnected が
     あれば接続由来」を機械的に判定可能になる。
2. **フラッピング原因の調査**
   - 02:02〜02:04 の background/foreground 周期発生の原因を MainActivity のライフサイクル周りから追う。
3. **今すぐの緩和策（要検討）**
   - 一時的な背面化で保留中プロンプトがキャンセルされないようガード。
   - ただし VS Code / Claude 拡張側の挙動のため、cc-studio 側だけで完全対処は難しい可能性。

## 参照

- 旧メモ: [[2026-06-30-connection-tool-cancel]]
- 検知/永続化コード: `plugins/state-observer.js`（detectCancel / observerLog / scanLocal）
- 抑制プラグイン: `plugins/keyboard-suppress.js`（suppressBox / denyKb）
- アップロード: `app/src/main/java/app/ccstudio/KeepAliveService.kt`（triggerUpload）
</content>
</invoke>
