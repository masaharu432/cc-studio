# CC Studio: rc-autoconnect プラグイン 設計 (v0.1)

最終更新: 2026-07-20
関連: [plugins/README.md](../../plugins/README.md)（プラグイン規約）, `docs/specs/2026-06-28-js-injection-plugin-design.md`（注入機構）, state-observer.js（フレーム作法・状態検知の先例）

## 1. 背景と動機

VS Code / code-server 拡張（`claude-vscode`）のセッションは、ユーザー設定 `remoteControlAtStartup: true` を
読んではいるが、**起動時オート接続がサーバ実験ゲート `ide_rc_auto_enable_gate`（statsig `tengu_ide_rc_auto_enable`,
既定 false）で抑止**されている。CLI 直起動では設定どおり自動接続する（実測確認済み）が、workbench 経由の
IDE セッションでは毎回手動 `/remote-control` が必要。

CLI 側の算出ロジック（native binary）:
```
remote_control_auto_enable = (remoteControlAtStartup 設定が true なら true)   ← 既に満たしている
ide_rc_auto_enable_gate    = statsig("tengu_ide_rc_auto_enable", false)       ← 唯一の障害
```

公式のゲート開放を待たずに、**workbench 経由の新規セッションで自動的に `/remote-control` を実行**して
RC を有効化し、公式モバイルアプリ / claude.ai/code から操作できる状態にする。extension.js は改変しない。

## 2. 方式判断（なぜプラグインか）

- extension.js のゲート判定を 1 行パッチする案もあるが、Anthropic 同梱コード改変で拡張更新のたびに消える。
- cc-studio プラグインは **全フレーム（claude-code の webview 本体フレームを含む）へ document-start 注入**され、
  UI 操作だけで目的を達成できる（chat-link-open が webview 本体フレームへ橋渡しする先例あり）。同梱コード改変なし・
  既存プラグイン規約にそのまま乗る。**採用。**
- 適用範囲は「アプリ / workbench を開いたブラウザが注入する経路」に限る。素のデスクトップ VS Code ネイティブ拡張
  単体には届かない（本プラグインの非対象）。

## 3. トリガー方針（確定）

**新規セッションのときだけ** `/remote-control` を 1 回実行する。

- webview の `/remote-control` は、未接続セッションで実行すると **確認（y/n）なしで即 RC 有効**になる（実測）。
  ただし接続済みセッションで実行すると切断/トグル側になり得るため、無検知で撃つ事故を避けて新規セッションに限定する。
- **ユーザーが意図的に RC を無効化する運用がある**。「RC 有効表示が無い＝張り直す」方式は、その無効化と喧嘩する
  ため採らない。新規判定に限れば、会話が動いている既存セッションで無効化した状態は尊重される。
- **リロード直後も発火する（実測・許容）**: リロード直後は既存セッションでもトランスクリプトが未描画で
  `assistant-message` が 0 件のため、新規と判定されて発火する。リロードは RC 接続を落とすので、そこで張り直すのは
  意図に沿う挙動であり、**仕様として受け入れる**（v0.1 設計時は「張り直さない」としていたが実挙動に合わせて改訂）。

## 4. ゴール / 非ゴール

**ゴール (v0.1)**:
- 新規セッション画面が開かれたとき、composer フレームで 1 回だけ `/remote-control` を送信して RC を有効化する
  （webview では確認なしで即有効になるため、送信＝完了。追加の確定操作は不要）。
- 二重送信しない（1 セッションにつき 1 回）。設定でライブ ON/OFF できる。送信失敗でクラッシュしない。

**非ゴール（当面・YAGNI）**:
- RC 接続状態の常時監視・明示的な再接続ロジック（リロード後の張り直しは §3 の副作用として得られるだけで、
  能動的に監視はしない）。
- 会話が動いている既存/再開セッションへの適用。
- デスクトップ VS Code ネイティブ拡張単体対応（extension.js パッチが別途必要な領域）。

## 5. アーキテクチャ

```
@all-frames true × @run-at document-start で全フレーム注入
  各フレームで:
    composer( [role="textbox"][aria-multiline="true"] ) が居るチャット本体フレームだけ作動、他は return
    「新規セッション」シグナルを判定
      ├ 非該当（既存/再開/リロード/接続済み） → 何もしない
      └ 該当（新規・未送信）                   → /remote-control を挿入して送信 →（確認が出たら肯定）
    once-guard（1 セッション 1 回）
```

- フレーム作法は state-observer / chat-link-open を踏襲（document-start 全フレーム注入、非対象フレームは即 return）。
- DOM 特定はクラス名に依存せず、テキスト/role など「必ず出る手掛かり」を使う（更新耐性）。

## 6. 検知・動作の詳細

### 6.1 composer フレームの特定
- `[aria-label="Message input"]`（webview の安定ラベル）を第一候補、`[role="textbox"][aria-multiline="true"]` を
  フォールバック。存在すれば作動対象フレーム。

### 6.2 「新規セッション」シグナル（実測確定）
- **アシスタント応答が 0 件＝新規**：`document.querySelectorAll('[data-testid="assistant-message"]').length === 0`。
  `assistant-message` は webview バンドルで確認した安定 data-testid（クラス名と違い更新耐性が高い）。
- ウェルカム画面のタグラインは**ランダム抽選**（webview が候補配列から毎回選ぶ）なので判定に使わない。
- 会話本文テキストへの substring マッチは使わない（0.1.0 で履歴内の "Welcome back" 等に誤ヒットして既存セッションで
  誤発火した反省）。testid のカウントのみで判定する。

### 6.3 送信（実測確定）
- composer は contenteditable（`.value` 代入不可）。focus → `document.execCommand('insertText', false, '/remote-control')`
  で挿入（失敗時は `beforeinput`/`input` の InputEvent へフォールバック）。実測で `insert exec=1` を確認。
- 送信は **送信ボタン `button[class*="sendButton"]` のクリックのみ**。ボタンが在るのに Enter も撃つと
  **二重送信**になり `/remote-control` が 2 回走る（0.6.0 の不具合）。ボタン未検出時のみ Enter へフォールバック。
- 送信後の確認プロンプトは無い（webview では確認なしで即 RC 有効）。追加の確定操作は不要。
- 送信 1.5 秒後に `verifyAfterSend` が `post empty=<composerが空か> banner=<"Remote Control" 文言の有無>` を出す。

### 6.4 冪等ガード（実測確定）
- **フレーム内メモリのフラグのみ**で「1 フレーム＝最大 1 回」。`sessionStorage` は使わない。
  （sessionStorage 版は webview オリジンに貼り付いてタブ・セッションをまたぎ、「一度撃つと二度と発火しない」
  不具合になった＝0.5.0 までの実害。）
- アシスタント応答が出たら（`amsg>0`）何もせず return する。**リセットはしない**（0.6.0 のリセットは送信失敗
  メッセージ後の再発火＝RC セッション乱造の危険があったため撤去）。新規セッションは新フレームで拾う。

## 7. プラグイン規約への適合（[plugins/README.md](../../plugins/README.md)）

- メタヘッダ:
  ```
  // ==CCStudioPlugin==
  // @name        rc-autoconnect
  // @version     0.1.0
  // @description Auto-enable Remote Control on newly started sessions (workbench).
  // @description:ja 新規に起動したセッションで自動的にリモートコントロールを有効化する（workbench 用）。
  // @run-at      document-start
  // @all-frames  true
  // @setting     enabled boolean true 新規セッションで自動接続する
  // @setting:ja  enabled 新規セッションで自動的にリモートコントロールに接続する
  // ==/CCStudioPlugin==
  ```
- 設定は `window.__ccPluginSettings['rc-autoconnect']` を読み、`ccstudio:setting` でライブ反映（enabled=false で無効）。
- ネイティブブリッジ（`window.CCStudio.*`）は使わない（UI 操作と診断ログのみ）。

## 8. 診断の作法

- focus-hud 共有バッファ `window.top.__ccStudioFocusLog` に `RC` プレフィックスで積む（focus-hud 無効でも無害）。
- 確定前の調査中は、新規判定シグナル候補・composer 検出・送信結果を DIAG 行として吐き、実機でセレクタ/手順を確定する
  （state-observer の DIAG 方式に倣う）。確定後は冗長ログを絞る。

## 9. エラー処理

- composer 不在フレーム: 即 return（正常）。
- 新規判定が偽: 何もしない。
- 送信・確認操作の例外: try/catch でログのみ、UI は止めない・クラッシュさせない。
- enabled=false: 何もしない。

## 10. リスクと留意

- **トグル誤爆**: 新規セッション限定により、接続済みセッションへ撃って切断する事故を回避。
- **ユーザーの意図的無効化**: 新規限定なので、既存セッションで無効化した状態は保持される。
- **リロードで RC が落ちる**: 本 v0.1 では張り直さない（リロードは稀＝プラグイン/拡張更新時のみとの前提）。将来必要に
  なれば別途「RC-active 目印の確実な検知＋ユーザー明示無効化の記憶」を伴う再接続機能を検討（非ゴール）。
- **公式ゲート開放**: 将来 `tengu_ide_rc_auto_enable` が開放されると本プラグインは不要になる。その時は無効化/削除で足りる。
- **DOM 更新耐性**: セレクタはクラス名非依存の手掛かりを使い、壊れたら DIAG で再確定する（`sendButton` のみ
  クラス部分一致だが、state-observer が停止ボタン検知で使う実績のある箇所）。
- **前提: RC 認証**: `CLAUDE_CODE_OAUTH_TOKEN`（setup-token）が環境にあると RC のセッション作成が 401 で失敗し、
  本プラグインが正しく送信しても RC は有効化されない。**`~/.claude/settings.json` だけでなく `~/.bashrc` の
  export も要確認**（claude を spawn する bash が読み込むため）。除去後は code-server の再起動が必要。
  切り分けは `/status` の「Auth token」表示と `Session create failed 401` ログ。

## 11. テスト（実機スクリーン）

- 新規セッション起動 → 自動で `/remote-control` が走り RC 有効（"Remote Control is active" 表示 / モバイルアプリに出現）。
- 既存/再開セッションを開く・リロードする → 発火しない（切断されない）。
- 新規セッションで既に接続済みの状態でも二重送信しない（冪等）。
- enabled=false → 一切発火しない。
- 送信手順が失敗する状況でもクラッシュしない（ログのみ）。

## 12. ファイル構成（cc-studio リポ）

```
plugins/rc-autoconnect.js        # 新規（本プラグイン本体）
plugins/focus-hud.js             # 変更: 展開表示に "-- RC (rc-autoconnect) --" 区画を追加 (1.6.7→1.6.8)
plugins/README.md                # 本数を 8→9 に更新
docs/specs/2026-07-20-rc-autoconnect-plugin-design.md   # 本書
```

## 13. 実機検証結果 (2026-07-20)

認証（§10 の `CLAUDE_CODE_OAUTH_TOKEN`）を除去し code-server を再起動した状態で、**新規セッション起動時に
プラグインが自動で `/remote-control` を送信し Remote Control が有効化されることを確認**（"Remote Control is
active" 表示、`Created session cse_…` 成功・401 ゼロ）。既存セッション（`amsg>0`）では発火しないことも確認済み。
