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

## 最終確定（6回目）: 根本原因 = VS Code 拡張の Edit/Write 権限プロンプト（bypass 無視バグ）＋約11分の自動 deny

### 証拠の連鎖（transcript キャンセル 8/8 が同一原因）

1. **exthost ログ一致**: 全キャンセルの瞬間、Claude 拡張ログ
   （`~/.local/share/code-server/logs/*/exthost*/Anthropic.claude-code/`）に
   `PreToolUse hook timed out (per-hook abort)` がミリ秒単位で一致
   （例: 16:03:05.519 timeout → 16:03:05.523 uQ 注入）。
2. **ユーザ定義 PreToolUse フックは不存在**（user/project/managed/全プラグイン確認。
   superpowers は SessionStart のみ）→ CLI が **UI への権限確認を内部的に PreToolUse フックとして
   実装**しているものが正体。
3. **タイムアウト長の実測**: tool_use 発行 → uQ 拒否 = 626〜668 秒。うち **3件が 668.2 秒で
   0.1 秒まで一致**（≈11分の固定定数）。
4. **全件 bypassPermissions 中に発生**（transcript の permissionMode 記録で確認。当初の
   「bypass でなかった」推定は誤り）。対象ツールは**全て Write/Edit**。
5. 既知バグと合致: [anthropics/claude-code#36219](https://github.com/anthropics/claude-code/issues/36219)
   — VS Code 拡張では **bypassPermissions でも Edit/Write だけ権限プロンプトが出る**
   （Bash/Read は正しく bypass。closed as not planned）。

### 確定した因果

```
Write/Edit 発行（bypass でも拡張バグでプロンプト生成 #36219）
 → プロンプトは webview UI へ（内部 PreToolUse フック）
 → phone 背面で WebView 凍結 ＝ 誰にも見えない・答えられない
 → ~668 秒（≈11分）で per-hook abort → 自動 deny
 → uQ「The user doesn't want to take this action…」＝ 突発キャンセル
```

- 「背面化から12.5〜14分後」の謎: 背面化 → 数分でターンが Write に到達 → **+11分**で一致。
- code-server は無実（両時刻ともログ沈黙・3h グレース健在）。レンダラ死・プロセス死も無し。
- webview 破棄→stream close の経路も実在するが（AskUserQuestion の stream-closed で実測）、
  記録済み 8 件の主因は全てタイムアウト経路。
- 前面で使用中でも発生しうる（19:27 の1件は本セッションの Edit。発行が11分前なら前面復帰後に拒否が届く）。

### 対策（bypass では防げないことが確定したため更新）

1. **通知で11分以内に応答**（現実的な第一防衛線）: 既存「🔔許可待ち」＋「⚠️中断」通知
   （Cancel 専用枠は APK 260702-1908。Stop 通知による上書き対策済み）。
2. **背面でも webview を生かす**（無音オーディオ keepalive 移植）: プロンプトが phone に
   表示され続ければ答えられる。優先度が上がった。
3. **上流バグ報告/追跡**: #36219 に「≈668s で自動 deny され 'The user doesn't want...' に化ける」
   という本調査の実測を添えて報告する価値あり（bypass の約束が破れている）。
4. 回避案の検証: 拡張パネルではなく**ターミナルで claude を走らせる**（拡張の Edit/Write
   プロンプト経路を通らない）が確実な回避になるか要検証。

### 回避策の本命候補: 「Edit automatically」(acceptEdits) モード

- 全プロジェクト transcript の実績（permissionMode 記録 vs uQ キャンセル）:
  bypassPermissions **10/6771**・auto **3/164**・**acceptEdits 0/37**・plan 0/79・default 0/32。
- 理屈: バグ #36219 は「bypass が **Edit/Write プロンプト**を抑止しない」。acceptEdits は
  Edit/Write の自動承認そのものが仕事なので、プロンプトを出す側を直接解決する別経路で効く見込み。
- UI 名の対応: モードピッカーの **「Edit automatically」= acceptEdits**（「Auto mode」= auto は
  キャンセル実績ありなので別物・非推奨）。
- **トレードオフ**: acceptEdits は Bash に効かない。bypass では Bash/Read は正しく素通りして
  いた（8件全て Write/Edit だった理由）ため、acceptEdits へ切替えると背面の Bash 承認待ちが
  新たな 668s キャンセル源になりうる → **Bash allowlist（permissions.allow）併用**が前提。
  `/fewer-permission-prompts` で整備できる。
- 決定実験: acceptEdits のセッションで Write を含むタスク→背面12分放置→完走すれば採用。
- **注意（上流の議論より）**: [#37518](https://github.com/anthropics/claude-code/issues/37518)
  （v2.1.78, closed as duplicate）は「**acceptEdits でも** Edit/Write の diff 承認が出る」と報告して
  おり、拡張の diff 承認フローは権限システム全体（allow ルール・defaultMode・bypass・acceptEdits）
  から**独立に動くリグレッション**とされている。同族 issue は #15772 #20536 #29159 #33047
  #36219 #36884 #43953 など多数で、メンテナ対応はほぼ無くステールクローズが目立つ。
  当時 2.1.78 → 現行 2.1.19x でバージョン差が大きいため、**実験の価値はある**（ローカル実績
  acceptEdits 0/37 はサンプル薄だが有望）。ダメなら残る回避は「ターミナルで claude 実行」
  「通知で11分以内に応答」「webview 延命」。
- **上流未報告の新情報（報告価値）**: どの issue も「~668 秒で自動 deny され
  『The user doesn't want to take this action』に化ける」挙動には触れていない。凍結クライアント
  （モバイル/code-server）での実測データ付きで新規報告する価値がある。

## 真の根本原因の確定と対処（7回目・2026-07-05）: 犯人は権限プロンプトではなく拡張の autosave フック

### きっかけ

facebook-friend セッション（CLI/拡張とも 2.1.201 = 最新でも再発）で同日 2 件の突発キャンセル。
transcript と exthost ログのミリ秒突合で、これまでの「bypass 無視の権限プロンプト（#36219）」説を**上書き修正**する決定的証拠が得られた。

### 証拠（facebook-friend 4da57fb3、2026-07-05 JST）

| 事象 | Edit 発行 | 拒否（uQ） | デルタ |
|---|---|---|---|
| 1件目（content.js） | 14:12:37.961 | 14:23:46.113 | **668.15 s** |
| 2件目（messages.json） | 14:25:43.183 | 14:36:51.358 | **668.18 s** |

決定打は 2 件目の exthost ログ:

```
14:25:43.200  [DiagnosticTracking] Captured baseline diagnostics for …/messages.json  ← captureBaseline は 17ms で完了
（11分間 沈黙）
14:36:51.359  PreToolUse hook timed out (per-hook abort)                              ← ハングしたのは「もう一方」のフック
```

### 機構（extension.js 実コードで確認）

拡張は SDK 経由で PreToolUse フックを **2 本だけ**登録している:

```js
hooks:{PreToolUse:[
  {matcher:"Edit|Write|MultiEdit", hooks:[(T)=>d.captureBaseline(T)]},   // 診断ベースライン取得。exthost 内で完結・同期・数ms
  {matcher:"Edit|Write|Read",      hooks:[(T)=>this.saveFileIfNeeded(T)]} // ★ claudeCode.autosave（既定 true）
]}
```

`saveFileIfNeeded` は `await vscode.workspace.openTextDocument(file)` を呼ぶ。
この API は **メインスレッド（＝レンダラ＝phone の WebView 上のワークベンチ）への RPC を必要とする**。
背面で WebView が凍結していると RPC が永遠に返らず、フックがハング →
CLI の per-hook タイムアウト（≈668 s）で abort → **フックタイムアウト = 自動 deny** として
uQ「The user doesn't want to take this action…」がターンに注入される。

```
Edit/Write/Read 発行
 → 拡張の autosave フック saveFileIfNeeded が openTextDocument を await
 → レンダラ（phone WebView）凍結中は RPC 応答なし
 → ≈668 s で per-hook abort → 自動 deny → uQ ＝ 突発キャンセル
```

### 6回目の結論の訂正

- **プロンプトはそもそも表示されていない**。「bypass が Edit/Write プロンプトを抑止しないバグ（#36219）」は本件の主因ではなかった。
- bypass で防げない理由も自明になった: **フックは permissionMode と無関係に走る**。
- acceptEdits への切替も**効かない**見込み（同じくフックは走る）。0/37 の実績はサンプル薄の偶然と解釈。
- 対象が Edit/Write だった理由はフックの matcher（Edit|Write|MultiEdit / Edit|Write|Read）。
  理論上は **Read も同経路で死にうる**（実測 8 件に無かったのは、Read はターン序盤＝前面中に多いためと推測）。
- ユーザ実測とも整合: キャンセル通知→即復帰→「続けて」で何事もなく進む（凍結が解ければフックは即完走する）。

### 対処（実施済み・2026-07-05）

`~/.local/share/code-server/User/settings.json` に **`"claudeCode.autosave": false`** を設定。
`saveFileIfNeeded` は先頭で `Cn("autosave")`（= `getConfiguration("claudeCode").get("autosave")`、毎回ライブ読み）を
チェックして即 return するため、レンダラ RPC 自体が発生しなくなる。
残る PreToolUse フック captureBaseline は exthost 内で完結（同期・実測 17ms）でハングしない。

- トレードオフ: エディタ上の未保存変更が Claude の Read/Edit 前に自動保存されなくなる
  （phone 運用では手動編集がほぼ無いため実害は小さい。PC 側で編集する時は手動保存を意識する）。
- 検証方法: bypass セッションで Write を含むタスク → phone を 12 分以上背面放置 → 完走すれば確定。
- 限界: AskUserQuestion 等「本当にユーザ応答が要る」対話は引き続き背面凍結で死にうる（これは原理的に不可避。通知で応答するしかない）。

## 追補（8回目・2026-07-05 15時台）: 対処後の再発 — 原因は「実行中スクリーンへ設定が伝播していなかった」

### 再発の実測（facebook-friend 4da57fb3）

- 15:16〜15:17 前面中: Read/Edit×5 が各 1 秒前後で成功（レンダラ生存中はフックは即完走）。
- 15:17:24.393 manifest.json への Edit 発行 → 直後に背面化 → **15:28:28.965 に同じ uQ 拒否（664.6 s）**。
- exthost ログも前回と同型: captureBaseline は 15:17:24.409（16ms）に完了ログ → 11 分沈黙 → per-hook abort。
- 設定書き込みは **14:53:50**（発生の 24 分前）。つまり `claudeCode.autosave: false` は
  ディスク上には在ったが、**その画面のワークベンチには届いていなかった**。

### 伝播しなかった理由（見立て）

設定は各ワークベンチウィンドウ（＝各スクリーンのレンダラ）が settings.json を watch して
在メモリ構成を更新し、それを exthost に押し込む方式。14:53 の書き込み時点で全スクリーンが
背面凍結中だったため変更イベントを取りこぼし、凍結解除（15:16）後も古い構成
（autosave=true）のまま動き続けた。**設定はスクリーンのリロード時には必ず読み直される**。

### 追加対応

1. 前面中に watcher を再発火させるため settings.json を touch（15:33）。
2. 運用ルール: **設定変更後は各スクリーンをリロード（またはアプリ再起動）してから検証する**。
   15:16 起動の「スクリーン5」以降の新規スクリーンは最初から autosave=false。

### 副次的な発見（通知と検知の変化）

- 今回、phone への通知は「⚠️中断」ではなく **「✅応答が完了しました」**。
  Claude(2.1.201) が uQ 拒否を受けて「手を止めました。…どう進めますか?」と丁寧に停止し、
  ターンが正常終了（Stop hook）した。**下層の 668s 自動 deny は同じ**で、見え方だけ変わった。
- UI 上の表示も「Edit failed」で、uQ の文言はチャット DOM に出ない
  → `state-observer.js` の detectCancel（本文文字列検知）は**この形の拒否を検知できない**。
  DOM 検知は既に補助へ格下げ済みだが、この検知漏れパターンも記録しておく。
- おまけ: この追補を書き込む Edit 自体も cc-studio セッション側で同じ uQ 拒否を一度食らった
  （＝機構が現役であることの実演）。

## 検証完了（9回目・2026-07-15）: 根治を確認 — 効いたのは autosave=false。上流 2.1.210 は別レイヤの保険

### 実地検証の結果

- ユーザ実測: 実装タスクを **15 分以上背面**で走らせて停止なし（従来なら確実に 668s deny の条件）。
- ログ裏付け: exthost 全ログの `per-hook abort` は **2026-07-05 15:45:28 が最後**
  （＝リロード前の cc-studio スクリーンで本メモ追記の Edit が弾かれた件）。以後 **10 日間ゼロ**。
- トランスクリプト全走査: 7/5 16:00 以降、全プロジェクトで**本物の uQ 拒否は 0 件**
  （ヒットは全て引用文）。この間の Edit/Write は **約 833 回**。

### どちらの修正で直ったかの切り分け

**主因の解消は `claudeCode.autosave: false`（当方の対処）**。根拠:

1. 拡張 2.1.210 でも `saveFileIfNeeded` は**一字も変わっていない**
   （autosave 設定を毎回読み、`openTextDocument` を await する構造のまま。既定も true のまま）。
   → 上流はハング自体を直していない。設定を戻せば背面凍結中のフックハングは今も再現するはず。
2. ハングが起きていれば結果がどうであれ exthost ログに `per-hook abort` が残るが、
   リロード徹底後は**タイムアウト自体が一度も発生していない**＝フックが即 return している
   ＝ autosave=false が全スクリーンで効いている。
3. 無拒否期間の大半は 2.1.201 のまま運用されており、上流修正の到着前から直っていた。

**上流の動き（2026-07-15 時点の Web 調査）:**

- [#36219](https://github.com/anthropics/claude-code/issues/36219)（bypass でも Edit/Write プロンプト）は
  **closed as not planned のまま**。修正版の言及なし。
- ただし **CLI 2.1.210 の CHANGELOG** に本件の症状ど真ん中の修正が入った:
  *"Fixed a hook callback timeout being misreported to the model as a user rejection,
  which made unattended sessions stop and wait"*
  → フックタイムアウトが「ユーザ拒否（uQ）」に化けて無人セッションが止まる、という
  **誤報告の方**が修正された。ハング（〜11 分停滞）自体は残るが、deny には化けなくなる。
  本調査（6 回目）で特定した機構そのものであり、時期的にも報告価値ありとした問題が上流で認知された形。

### 結論（防御の全体像）

| レイヤ | 状態 |
|---|---|
| ハングの発生源（autosave フックのレンダラ RPC） | **autosave=false で根絶**（当方対処・実証済み） |
| タイムアウト→uQ 拒否化 | 2.1.210 で上流修正（保険。autosave を戻しても「11 分停滞」止まりになる見込み） |
| 残存リスク | AskUserQuestion 等の真の対話待ちは背面凍結で依然死にうる（通知で応答するしかない） |

運用上の注意: 拡張の既定は今も autosave=true のため、**設定の消失（プロファイル再作成・
別サーバ構築時）で再発する**。vsserver 構築手順に `claudeCode.autosave: false` を含めること。

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
