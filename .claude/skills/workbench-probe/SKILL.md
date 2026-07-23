---
name: workbench-probe
description: Use when verifying or debugging cc-studio plugin / workbench UI behavior and you need evidence from the REAL running code-server — computed styles, DOM structure, HUD (focus-hud) logs, viewport/zoom state, or a screenshot of what the phone would show. Use INSTEAD OF asking the user for device screenshots, and INSTEAD OF grepping server/code-server sources (the submodule version differs from the running server — CSS/DOM conclusions from grep have been wrong before).
---

# workbench-probe — 稼働中 workbench を CDP で実測する

headless Chrome (CDP) で **実際に動いている code-server**（既定 `127.0.0.1:8088`、
[vsserver](../vsserver/SKILL.md) が常駐させているもの）に入り、スマホ相当エミュレーション・
プラグイン注入・HUD 読み取り・スクリーンショット・任意 JS 評価を行う。

**鉄則: UI の因果はソース grep や推測ではなく、実物への注入・実測で確定する。**
サブモジュール `server/code-server` と稼働サーバは**別の版**であり、CSS カスケードの
結論を grep で出して外した実績がある（ui-zoom v0.4.0: `.part > .content` の 13px
再指定を見落とし、ツリー・タブにフォント上書きが届かなかった）。

## 使い方

```bash
node .claude/skills/workbench-probe/probe.mjs [flags]
```

| flag | 意味 |
|---|---|
| `--mobile` | スマホ縦画面エミュレート（412x915 dpr2.625, viewport meta 有効 = 実機同等） |
| `--settings '<json>'` | `window.__ccPluginSettings` に入れる値（プラグインより先に注入） |
| `--plugin <file>` | document-start 相当で全フレームへ注入（繰り返し可・指定順） |
| `--eval '<expr>'` | トップフレームで評価し JSON 出力（繰り返し可） |
| `--hud` | focus-hud 共有バッファ `__ccStudioFocusLog` を出力（UZ/ST 等の診断行） |
| `--shot <png>` | スクリーンショット保存 → **Read で自分の目で確認する** |
| `--url` / `--wait <sel>` / `--settle <ms>` | 接続先 / 待機セレクタ / 追加待ち（既定 3s） |

認証は `~/.config/code-server/config.yaml` の password で自動ログイン（何も保存しない）。

## 典型例 — プラグインを実機同等条件で検証

```bash
node .claude/skills/workbench-probe/probe.mjs --mobile \
  --settings '{"ui-zoom":{"enabled":true,"diag":true}}' \
  --plugin plugins/ui-zoom.js \
  --hud --shot /tmp/probe.png \
  --eval 'window.innerWidth' \
  --eval 'getComputedStyle(document.querySelector(".monaco-list-row")).fontSize'
```

CSS カスケードの犯人探しは、祖先チェーンの computed 値を並べると一発:

```bash
--eval '(function(){var e=document.querySelector(".monaco-list-row"),o=[];while(e&&e!==document.body){o.push([String(e.className).slice(0,50),getComputedStyle(e).fontSize]);e=e.parentElement}return o})()'
```

## できないこと

- **クロスプロセス iframe (OOPIF)** への `--plugin` 注入は届かない（code-server は
  webview 同一オリジンなので通常は全フレーム届く）。
- 実タッチ・実 WebView 固有差（System WebView の版差・IME・キーボード連動）は最終的に実機。
- スクリーンショットは 1 ページ分のみ（スクロール合成なし）。

## ありがちな間違い

- スクショだけ見て終わる → `--eval` で数値も取る（視覚とデータの両方が証拠）。
- `--settle` 不足で「効いていない」と誤判定 → プラグインの tick は 1s 周期。既定 3s で足りるが、
  遅い判定を疑うときは `--settle 6000`。
- 稼働サーバを見ずにサブモジュールを grep して結論 → 本スキルの存在理由。実測が正。
