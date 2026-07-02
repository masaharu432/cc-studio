# CC Studio: switcher の「スクリーン / 設定」分離と OS バックのナビスタック 設計

最終更新: 2026-07-02
関連:
- [Screens と Plugins システムスクリーン 設計](2026-06-28-screens-and-plugins-design.md)（switcher と SYSTEM ドックの現行設計。本書はそのドックを置き換える）
- 各オーバーレイ（notify / log / plugin-settings）の中身は本設計では変えない（エントリポイントと戻り遷移のみ変わる）
- デザインモック: [docs/design/switcher-tabs-mock.html](../design/switcher-tabs-mock.html)（レンダー: `docs/design/previews/switcher-tabs-mock-*.png`、git 追跡外。`#settings` 付きで開くと設定側から表示）

## 用語
UI 語彙は既定通り **Screen / スクリーン** と **Plugin / プラグイン** に統一する。本書で導入する切替 UI は設計用語として「**タブバー**」と呼ぶが、**UI 文言に「タブ」は出さない**（画面上のラベルは「スクリーン」「設定」の2語のみ）。

---

## 1. 背景とゴール

### 問題
1. **設定項目がスクリーン一覧の面積を奪う。** switcher 下部の SYSTEM ドック（[switcher.html](../../app/src/main/assets/switcher.html) の `.dock`）は プラグイン / 通知 / ログ の3枠固定で、今後「接続・サーバー」「Files」等が増えるたびにドックが縦に伸び、高頻度操作であるスクリーン切替の表示域を圧迫する。
2. **設定系エントリの実装がアドホック。** 通知とログは switcher.html にハードコードされたカード、プラグインだけシステムスクリーン一覧からの動的描画、と構造が混在しており、項目追加のたびに switcher.html の改修が要る。
3. **OS バックが設定系で使えない。** [MainActivity.kt:123-135](../../app/src/main/java/app/ccstudio/MainActivity.kt#L123-L135) の if 連鎖は notify と switcher しか見ておらず、**ログとプラグイン設定は OS バック非対応**（アプリ内 ‹ ボタン頼み）。

### ゴール
- スクリーン一覧は常に全高を使え、設定は項目が何個に増えても一覧性を保つ。
- 設定項目の追加が「レジストリに1エントリ足すだけ」になる。
- 設定系の画面では OS バックで一段ずつ戻れる。スクリーン表示中の「バック＝WebView 履歴 → バックグラウンド化」は現行維持。

### 設計判断の軸（頻度の非対称性）
スクリーン切替は高頻度・設定は低頻度。よって**設定への +1 タップは許容し、設定がスクリーン一覧の面積を常時奪うことは許容しない**。分岐の深さ自体は問題ではなく、「2階層まで・OS バックで機械的に戻れる」ことで操作コストを抑える。

---

## 2. switcher のタブバー化

### 2.1 構造
SYSTEM ドックを廃止し、switcher 最下部（旧ドックと同位置・同質感）に **タブバー「スクリーン / 設定」** を置く。

- **スクリーン**: 現行の帯リスト（＋ New screen / Web スクリーン帯）のみ。全高を使う。挙動変更なし。
- **設定**: グループ見出し付きのコンパクト1行リスト（アイコン＋ラベル＋補足＋›）。カード型にはしない（1行=約56px なら 10〜15 項目が1画面に収まり一覧性を保てる）。
- switcher を開いたときの初期表示は常に**スクリーン側**（高頻度側を既定に）。
- ヘッダーのタイトル（SCREENS / SETTINGS）とサマリ行はタブに連動。

### 2.2 設定側の構成（初期）

| グループ | 項目 | 遷移先 |
|---|---|---|
| プラグイン | プラグイン管理 | 既存 plugins システムスクリーン（`ScreenManager.select()`） |
| システム | 通知 | 既存 notify オーバーレイ |
| システム | ログ | 既存 log オーバーレイ |

per-plugin ⚙ → plugin-settings の流れは現行のまま。plugins.html / plugin-settings.html / notify.html / log.html の中身は変更しない。変わるのは**エントリポイントがドック → 設定リストに移ること**だけ。

### 2.3 設定レジストリ（データ駆動化）
ハードコードのカードをやめ、native が設定エントリ一覧を JSON で返す。

```
CCStudio.listSettings() → [
  { id:"plugins", group:"プラグイン", icon:"🧩", label:"プラグイン管理",
    sub:"3 個インストール · 2 有効", action:"screen:plugins" },
  { id:"notify",  group:"システム",   icon:"🔔", label:"通知",
    sub:"Stop / Notification フック", action:"overlay:notify" },
  { id:"log",     group:"システム",   icon:"📋", label:"ログ",
    sub:"オブザーバーログを表示",     action:"overlay:log" },
]
```

- `action` は `screen:<id>` / `overlay:<name>` の2形式。switcher 側は文字列をそのまま `CCStudio.openSettingsEntry(id)` に渡すだけで、遷移の実体は native が解決する。
- 将来項目（接続・サーバー、Files 等）は native 側レジストリへの追加のみで switcher.html は無改修。

---

## 3. OS バック: 明示的ナビスタック

### 3.1 モデル
現行の if 連鎖を、**オーバーレイ/状態を開くたびに push・バックで pop する明示的スタック**に置き換える（`MainActivity` 内、要素は enum + 付帯情報）。

```
スタック要素: SWITCHER(tab) | PLUGINS_SCREEN | NOTIFY | LOG | PLUGIN_SETTINGS(pluginName)
```

pop 時の遷移（上から順に評価）:

| 現在の最上位 | OS バックの結果 |
|---|---|
| PLUGIN_SETTINGS | 閉じて plugins スクリーンへ（下の PLUGINS_SCREEN が残る） |
| PLUGINS_SCREEN | switcher（設定側）を開き直す（設定リストから開いた文脈を保つ） |
| NOTIFY / LOG | 閉じて switcher（設定側）へ |
| SWITCHER（設定側） | スクリーン側へ切替（タブバーの「ホーム」はスクリーン側） |
| SWITCHER（スクリーン側） | switcher を閉じてアクティブスクリーンへ |
| （スタック空・Web スクリーン表示中） | `webView.canGoBack()` なら `goBack()`、尽きたら `moveTaskToBack(true)`（現行維持） |

- 設定リストから「プラグイン管理」を開くと、switcher は隠れるがスタックには `PLUGINS_SCREEN` が push される（plugins は overlay ではなく Screen だが、設定導線の一部としてスタックに載せる）。Web スクリーンへ切替えた時点でスタックはクリアする（設定導線を離れたため）。
- アプリ内の ‹ ボタンは残す（画面上の明示的な戻り口）。実装は**同じ pop 処理を呼ぶ**だけにして、二重の遷移ロジックを持たない。plugins.html の「‹ Screens」も pop 経由となり、設定側に戻る（ラベルは「‹ 設定」に改める）。

### 3.2 整合性
- single source of truth は**スタック**。open/close は必ずスタック操作経由で行い、View の visibility はスタックから導出する（visibility を直接いじる経路を残さない）。
- ログ・プラグイン設定が OS バック非対応な現行の穴はこの置き換えで解消。

### 3.3 非ゴール
- Android 13+ の予測バック（predictive back gesture）対応は将来課題。本設計のスタック化はその前提整備を兼ねる。

---

## 4. 変更範囲

| ファイル | 変更 |
|---|---|
| `app/src/main/assets/switcher.html` | ドック撤去、タブバー追加、設定リスト描画（`listSettings()` 駆動）。モックの CSS を移植 |
| `app/src/main/java/app/ccstudio/MainActivity.kt` | ナビスタック導入（if 連鎖置き換え）、設定レジストリ、`openSettingsEntry` ハンドラ |
| `app/src/main/java/app/ccstudio/CcBridge.kt` | `listSettings` / `openSettingsEntry` 追加 |
| 非変更 | plugins.html / plugin-settings.html / notify.html / log.html、ScreenManager の仕組み |

---

## 5. 検証（手動）

1. switcher を開く → スクリーン側が初期表示、帯リストが最下部タブバーまで全高を使う。
2. 設定側に切替 → プラグイン管理 / 通知 / ログ がグループ見出し付きで表示。各項目が現行と同じ遷移先に飛ぶ。
3. OS バックの連鎖: プラグイン設定 → プラグイン管理 → 設定側 → スクリーン側 → switcher 閉、の順で一段ずつ戻る。
4. ログ・通知を開いて OS バック → 設定側に戻る（従来はログでバックが効かなかった）。
5. Web スクリーン表示中の OS バック → WebView 履歴 → 尽きたらバックグラウンド化（現行と同じ）。
6. ‹ ボタンと OS バックが常に同じ遷移になる。
