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
