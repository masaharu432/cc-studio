# CC Studio インストールガイド

CC Studio を使えるようにするまでの全手順。登場するマシンは 3 つ:

| 役割 | 例 | 置くもの |
|---|---|---|
| **サーバ** | Linux / WSL2 | code-server + Claude Code 拡張 + 通知サーバ（notify-relay） |
| **前段ホスト** | Windows（WSL の親）等 | `tailscale serve`（HTTPS 終端）。サーバと同一マシンでも可 |
| **スマホ** | Android 8.0+ | CC Studio アプリ + Tailscale アプリ |

セキュリティは **Tailscale（tailnet）前提**: サーバはインターネットに一切公開せず、
自分の tailnet 内からだけ届く。暗号化と端末認証は Tailscale（WireGuard）が担い、HTTPS は
`tailscale serve` が終端する。code-server 自体にもランダム生成パスワードの認証が付く。

## 0. 前提

- サーバ: `curl`、`python3`（または `jq`）、`node`（通知機能に必要）、systemd user instance（推奨。無くても可）
- Claude Code がサーバ上で動くこと（`claude` CLI ログイン済み）
- アプリを自分でビルドするため JDK 17 + Android SDK cmdline-tools（手順は §4）

## 1. Tailscale

すべての通信が Tailscale に乗るので最初に整える。

### サーバ / 前段ホスト

- **Linux サーバ（実機）**:
  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  ```
- **WSL2 の場合**: Tailscale は **Windows 側**にインストールする（[ダウンロード](https://tailscale.com/download/windows)し、
  同じアカウントでログイン）。WSL 内には入れない。あわせて WSL2 を **mirrored networking** にすると
  Windows ⇔ WSL で loopback が共有され、後述の `tailscale serve` が WSL 内のポートへ届く:
  `%UserProfile%\.wslconfig` に
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  を書いて `wsl --shutdown` → 再起動。

### tailnet の HTTPS を有効化（初回のみ）

[Tailscale 管理コンソール](https://login.tailscale.com/admin/dns) の **DNS** で
**MagicDNS** と **HTTPS Certificates** を有効にする。これで `tailscale serve` が
`https://<ホスト名>.<tailnet 名>.ts.net/` の証明書を自動発行できる。

### スマホ

Play ストアから **Tailscale** を入れ、同じアカウントでログインして VPN を ON にする
（常時接続を推奨）。これでスマホから `https://<your-tailnet-host>/` に届くようになる。

## 2. サーバのセットアップ（1 コマンド）

```bash
git clone <this-repo> && cd cc-studio
./server/provision/setup.sh
```

冪等（何度実行しても安全）。やること:

1. **code-server のインストール** — 公式プレビルド配布（standalone）を `~/.local` へ。
   ソースからのビルドはしない（同梱 submodule は参照用）。
2. **config 生成** — `~/.config/code-server/config.yaml` を無い時だけ生成。
   認証パスワードをランダム生成して書き込む（既存ファイルは保全）。**初回ログインに使うので
   `cat ~/.config/code-server/config.yaml` で控えておく。**
3. **常駐化** — systemd ユーザサービス `vsserver` を有効化（boot 時自動起動）。
   systemd が無い環境は `./server/provision/start-vsserver.sh` で手動起動。
4. **推奨設定の投入** — `.md`/`.html` をタブ内フルサイズプレビューで開く設定を既存設定へ非破壊 merge。
5. **拡張のインストール** — Claude Code 公式拡張のほか、HTML プレビューを**タブとして開ける**
   マーケットプレイス拡張 `aios-html-auto-preview` など（`extensions.txt`）+ 同梱拡張 **cc-open**
   （チャットのリンクから開いた `.md` をプレビュー表示にする）。
6. **通知機能** — 通知サーバ **notify-relay**（`127.0.0.1:8770`）を常駐化し、Claude Code の
   user フック（Stop / 許可待ち → relay へ POST）を `~/.claude/settings.json` に登録。

ポートや既定フォルダを変えたい場合は `cp server/provision/cc-studio.env.example server/provision/cc-studio.env`
を編集してから実行（詳細: [server/provision/README.md](server/provision/README.md)）。

## 3. HTTPS 公開（tailscale serve）

**Claude Code 拡張は HTTPS でないと正常に動かない**（セキュアコンテキスト前提）ため、
前段ホストで `tailscale serve` を一度だけ設定する。**WSL の場合は Windows の PowerShell で**実行:

```powershell
tailscale serve --bg 127.0.0.1:8088                                  # ワークベンチ本体
tailscale serve --bg --set-path /cc-notify http://127.0.0.1:8770     # 通知・ログ収集
```

- 設定は永続なので一度だけでよい。確認は `tailscale serve status`。
- Git Bash から実行する場合は `/cc-notify` がパス変換されるので `MSYS_NO_PATHCONV=1` を付ける。
- Linux 実機サーバなら同じコマンドをサーバ上で実行（`install-notify.sh` が 2 行目を自動試行済みのこともある）。

ブラウザで `https://<your-tailnet-host>/` を開き、§2 で控えたパスワードでログインできれば OK
（302 → ログイン画面は正常）。初回に Claude Code 拡張へのログインも済ませておくとスマホ側が楽。

## 4. アプリのビルドとインストール

配布 APK は無いので自分でビルドする（WSL/Linux）:

```bash
sudo apt-get install -y openjdk-17-jdk unzip
export ANDROID_HOME="$HOME/Android/sdk"   # 永続化するなら ~/.bashrc に追記
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

アプリが既定で開くワークベンチ URL は**コミットしない**。`local.properties`（gitignore 済み）に各自書く:

```properties
sdk.dir=/home/<you>/Android/sdk
ccstudio.targetUrl=https://<your-tailnet-host>/?folder=/path/to/open
```

ビルドと端末へのインストール:

```bash
./gradlew assembleDebug
# -> app/build/outputs/apk/debug/cc-studio-<ビルド時刻>.apk
adb install -r app/build/outputs/apk/debug/cc-studio-*.apk
```

`adb` を使わない場合は、APK を共有フォルダ等からスマホでダウンロードして開けば OS がインストールする。
版数はビルド時刻 `yyMMdd-HHmm`（常に増えるので上書きインストールが通る）。

## 5. スマホ側の初回セットアップ

1. **Tailscale VPN が ON** なことを確認して CC Studio を起動。code-server のログイン画面が出たら
   §2 のパスワードを入力（以後保持される）。
2. **通知を許可** — 起動時に通知許可を求められるので許可する（接続維持の常駐通知と、
   Claude の完了・許可待ち通知に必要）。
3. **電池最適化を除外** — 設定 → アプリ → CC Studio → バッテリー → 「制限なし」。
   バックグラウンドでの接続維持・通知の取りこぼし防止。
4. **プラグインを取り込む** — 左端 `⋮` → SYSTEM の **Plugins** → `＋ Add plugin` で
   リポジトリの [`plugins/`](plugins/) から `.js` を選んで ON にする。常用推奨:
   - `keyboard-suppress` — キーボード暴発の抑制
   - `session-list-readable` — セッション一覧を読めるように
   - `chat-link-open` — チャットのファイルリンクをタブで開く
   - `selectable-text` / `region-grab` — コピー機能（長押し／範囲囲み）
   - `state-observer` — 処理中・接続切れの表示と通知連携
   - （`focus-hud` / `select-diag` は不具合調査用。普段は不要）

   ON にしたら switcher に戻り、反映したいスクリーンを `⟳` でリロード。

## 6. 動作確認

- スマホでフォルダを開いて Claude Code にタスクを投げ、**アプリを裏に回して数分放置** →
  戻っても切断ポップが出なければ接続維持 OK。
- タスク完了時に **OS 通知**が出れば通知系 OK（見ているスクリーンの通知は出ない仕様。
  別アプリを表に出して待つ）。出ない場合: サーバで `systemctl --user status notify-relay`、
  `tailscale serve status` に `/cc-notify` があるか、既存の Claude セッションを一度リロードしたか
  （フック読込はセッション開始時）を確認。
- サーバ側の状態確認・再起動はリポジトリ同梱の `/vsserver` スキル、または:
  ```bash
  systemctl --user status vsserver     # 稼働確認
  systemctl --user restart vsserver    # 再起動
  journalctl --user -u vsserver -f     # ログ
  ```
