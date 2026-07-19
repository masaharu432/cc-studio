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
  ため採らない。新規判定に限れば、既存セッションで無効化した状態は尊重される（既存＝会話が空でない＝非該当）。
- スクリーンのリロード（実質プラグイン更新時・VS Code 拡張更新時のみで稀）後に RC が張り直されないのは許容する。

## 4. ゴール / 非ゴール

**ゴール (v0.1)**:
- 新規セッション画面が開かれたとき、composer フレームで 1 回だけ `/remote-control` を送信して RC を有効化する
  （webview では確認なしで即有効になるため、送信＝完了。追加の確定操作は不要）。
- 二重送信しない（1 セッションにつき 1 回）。設定でライブ ON/OFF できる。送信失敗でクラッシュしない。

**非ゴール（当面・YAGNI）**:
- RC 接続状態の常時監視・自動再接続（リロード後の張り直しはしない）。
- 既存/再開セッションへの適用。
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
- `COMPOSER_SEL = '[role="textbox"][aria-multiline="true"]'`（state-observer 実績のセレクタ）。存在すれば作動対象。

### 6.2 「新規セッション」シグナル（spike で実機確定）
候補（安定手掛かり優先）:
- ウェルカム画面の文言（"Welcome back" / "/init" / "What's new" 等）が可視、または
- トランスクリプトにメッセージバブルが 0 件（会話が空）。
- クラス名依存は避け、テキスト/role/構造で判定。DIAG ダンプ（§8）で最終確定。

### 6.3 送信（spike で実機確定）
- composer は React/Lexical 系のため `.value` 代入は不可。focus → `document.execCommand('insertText', false, '/remote-control')`
  もしくは `beforeinput`/InputEvent、その後 Enter（KeyboardEvent）で送信。あるいは送信ボタン起動。
- `/` によるスラッシュコマンド補完ポップアップが Enter を横取りする可能性を実機で確認し、必要なら補完確定 or
  ポップアップ回避の手順を入れる。
- 送信後の確認プロンプトは無い（webview では即 RC 有効）。追加の確定操作は不要。

### 6.4 冪等ガード
- 1 セッション 1 回に制限する once-guard を置く。実体（フレーム内フラグ / sessionStorage / セッション ID マーカーの
  いずれか）と、送信〜接続完了までのクールダウンは spike で確定。少なくとも「同一ページ生存中に複数回撃たない」を保証。

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
- **DOM 更新耐性**: セレクタはクラス名非依存の手掛かりを使い、壊れたら DIAG で再確定する。

## 11. テスト（実機スクリーン）

- 新規セッション起動 → 自動で `/remote-control` が走り RC 有効（"Remote Control is active" 表示 / モバイルアプリに出現）。
- 既存/再開セッションを開く・リロードする → 発火しない（切断されない）。
- 新規セッションで既に接続済みの状態でも二重送信しない（冪等）。
- enabled=false → 一切発火しない。
- 送信手順が失敗する状況でもクラッシュしない（ログのみ）。

## 12. ファイル構成（cc-studio リポ）

```
plugins/rc-autoconnect.js        # 新規（本プラグイン本体）
plugins/README.md                # 一覧に 1 行追記（本数更新）
docs/specs/2026-07-20-rc-autoconnect-plugin-design.md   # 本書
```
