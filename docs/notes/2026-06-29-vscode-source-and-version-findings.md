# VS Code/code-server ソース調査と稼働バージョンの食い違い

- 日付: 2026-06-29
- 種別: 調査メモ（再調査の寄り道を防ぐための記録）
- きっかけ: モバイルで「読み取り専用テキスト（チャット本文・Markdown プレビュー）をコピーしたい」機能の
  実装にあたり、`user-select` 等の挙動を実ソースで裏取りしようとしたこと。
- 関連: [selectable-text 設計](../specs/2026-06-29-selectable-text-design.md) / [region-grab 設計](../specs/2026-06-29-region-grab-design.md)

## 要点（TL;DR）

1. **submodule の VS Code と、実際に稼働しているサーバの VS Code は別物**。バージョン番号は同じ 1.126.0 でも
   コミットが違う。`server/code-server` からビルドしているのではなく、provision はプレビルド release を入れている。
2. **submodule の VS Code（`7e7950df`）には `src/vs/sessions` という Microsoft の「エージェント・セッション」面が
   入っており、モバイル専用機能も持つ**が、これは **code-server が配信する通常ワークベンチとは別エントリの別プロダクト**
   （`platform/agentHost` 依存・Copilot 系）。cc-studio が載せる Claude Code 拡張とは無関係で、移植可能な“設定”ではない。
3. **`user-select` 解放（CSS）も JS の Selection API も、稼働 WebView ではネイティブ選択 UI を起動できなかった**
   （実機）。Android WebView の選択 ActionMode は WebView 自身のジェスチャ認識でしか出ず、対象 iframe では起動しない／
   JS から召喚できない。→ ネイティブ選択に依存しない **region-grab（自前オーバーレイ矩形選択）** が必要になった。

## バージョン座標（3つ・混同注意）

| 座標 | 値 | 由来 |
|---|---|---|
| cc-studio の `server/code-server` submodule pin | `dd48f775`（`git describe`: `v4.15.0-610-gdd48f775`） | `.gitmodules`（url: coder/code-server） |
| その中の `lib/vscode` submodule pin | `7e7950df`（microsoft/vscode, 1.126.0, 2026-06-23, bot コミット） | code-server の `.gitmodules`（url: microsoft/vscode） |
| **実際に稼働しているサーバ** | **code-server 4.126.0 / VS Code 1.126.0 / commit `2c06497c`（vanilla 上流）** | `code-server.dev/install.sh --method standalone` のプレビルド |

- provision は [`server/provision/setup.sh`](../../server/provision/setup.sh) の
  `curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone` で**プレビルド版を取得**する。
  → オンディスクの `server/code-server`/`lib/vscode` submodule は**ビルドに使われていない**。
- 稼働実体は `~/.local/lib/code-server-4.126.0/lib/vscode/`。`product.json` に
  `version 1.126.0` / `commit 2c06497ca93cab8ced876947c58e6b42be5a8210` / `quality stable`。

## `src/vs/sessions`（submodule にあるモバイル機能）の正体

- `src/vs/sessions/` は **464ファイル**の独立サブシステム。エントリは `sessions.web.main.ts`
  （通常の `workbench.web.main.ts` とは別）。
- 正体は **Microsoft の「エージェント・セッション」面**：
  - `common/welcome.ts` に `WELCOME_COMPLETE_KEY = 'workbench.agentsession.welcomeComplete'`。
  - `common/sessionConfig.ts` が `../../platform/agentHost/.../commands.js` を import（**agentHost バックエンド依存**）。
  - `browser/parts/mobile/` に `mobileChatShell` / `mobileVisualViewport` / `longPress` / `mobileEdgeSwipe` /
    `mobilePickerSheet` / `mobileSessionFilterChips` 等のモバイル一級機能。
- **稼働ビルド（1.126.0 / 2c06497c）には `sessions` のモバイルチャットは無い**（`out/` に `mobileChatShell` 等が存在せず）。
- 結論: これは Microsoft の Copilot 系エージェント面で、**通常ワークベンチの“モバイル設定トグル”ではない**。
  agentHost 前提のため自前 code-server で素直に立つものでもなく、**Claude Code を載せる cc-studio の代替にはならない**。
  ただし「Microsoft が VS Code 本体にモバイル一級対応を作り込み始めた」事実は cc-studio の問題設定の妥当性を裏付ける。
  実装パターン（例: `mobileVisualViewport.ts` のキーボード高ハンドリング）は将来の参考に値する。

## `user-select` まわり（稼働 1.126.0 で確認）

- 稼働ビルド `out/` 全体に **`user-select: none !important` は 0 件**（`text !important` は 8件＝diffEditor 等の意図的なもの）。
  `user-select:none` はすべて素。→ `!important` 付きの解放は特異度に関係なく全勝する（CSS 上は）。
- ルートの選択禁止は `src/vs/workbench/browser/media/style.css` の `body { user-select: none }`（素）。
- Monaco は選択を独自描画で管理（DOM の `user-select` は通常 `none`、`view-lines` だけ macOS lookup 用に `text`）。
- チャット/プレビューは**拡張 webview（iframe）**。webview は同一オリジン自己ホスト（`patches/webview.diff`、
  `pre/index.html` の CSP は `style-src 'unsafe-inline'` 許可で `<style>` 注入は通る）。
- `patches/clipboard.diff` の `_remoteCLI.setClipboard` は CLI→**サーバ側** `IClipboardService.writeText` で、
  ブラウザのコピーとは別物。

## 実機で判明した決定的事実（CSS/JS だけでは解けない）

机上では「`user-select` を解放すればネイティブ選択が生きる」見込みだったが、**実機では起動しなかった**：

- selectable-text（CSS で `user-select:text` 広域解放＋`-webkit-touch-callout` 解放）→ 長押ししても
  選択ハンドルが出ず、使えない Cut/Copy/Paste メニューが出るだけ。チャット本文・Markdown プレビュー両方で同様。
- 段階2（capture で `selectstart`/`contextmenu` の JS 横取りを停止）→ 変化なし。
  しかも vanilla の Markdown プレビューでも出ない＝「JS 横取り」が原因ではないことを示す。
- JS プログラム選択（`caretRangeFromPoint` + `Selection.modify('word')` で能動選択）→ ハンドル/Copy バー出ず。

→ **Android WebView の選択 ActionMode は WebView 自身のネイティブ・ジェスチャ認識でのみ起動し、これらの
webview iframe では起動しない／JS から召喚できない**、という結論。CSS でも JS でもネイティブ選択 UI は呼べない。
そのため **ネイティブ選択を一切使わない region-grab（自前オーバーレイで矩形選択→DOM テキスト収集→自前でコピー）** に
切り替え、実機でコピー成功を確認した。

## 再現メモ（コマンド）

```bash
# submodule の VS Code 本体を浅く取得して読む（pin 通りの checkout・無改変）
cd server/code-server
git submodule update --init --depth 1 lib/vscode
# ※ WSL の Windows マウントだと dubious ownership が出る。個別に safe.directory を通す:
#   git config --global --add safe.directory <abs path>/server/code-server/lib/vscode

# 稼働サーバの実バージョン
ls ~/.local/lib/ | grep code-server                     # -> code-server-4.126.0
grep -E '"commit"|"version"' ~/.local/lib/code-server-4.126.0/lib/vscode/product.json

# 稼働ビルドの user-select 実態（!important の有無が肝）
cd ~/.local/lib/code-server-4.126.0/lib/vscode
grep -rhoE 'user-select:\s*none\s*!important' out | wc -l   # -> 0
```

## 注意・含意

- 「submodule が新しい＝モバイル機能が来る」は**誤り**。submodule のモバイル機能は agentHost/sessions 面のもので、
  code-server が配信する通常ワークベンチ（Claude Code を載せる面）には来ない。
- 機能の裏取りは **submodule の pin ではなく、稼働ビルド `~/.local/lib/code-server-<ver>/lib/vscode/out` の実体**に
  対して行うこと（両者はバージョンが一致しない）。
- モバイルでの「読み取り専用テキストのコピー」は、ネイティブ選択ではなく自前オーバーレイ（region-grab）で解くのが正解。
