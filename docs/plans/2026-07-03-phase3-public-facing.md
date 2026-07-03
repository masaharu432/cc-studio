# フェーズ3: 公開体裁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** リポジトリを公開できる体裁にする（docs 統一・LICENSE・README 日英・最終個人情報スキャン）。コードは触らない。

**Architecture:** 文書とメタファイルのみの変更。ビルド・テストへの影響なし（最後に一度だけ回して無影響を確認）。

## Global Constraints

- スペック: `docs/specs/2026-07-02-public-release-refactor-design.md` フェーズ 3。
- 個人情報スキャンは**追跡ファイルのみ**（`git grep` / `git rev-list` ベース）。パターン: `<user>|masaharu|<tailnet>|100\.\d+\.\d+\.\d+`（`masaharu432` の author 名と noreply メールは公開 ID なので許容）。
- コミット末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

### Task 1: docs 置き場の統一

- [ ] `git mv docs/superpowers/specs/*.md docs/specs/`（3 本）、`git mv docs/superpowers/plans/*.md docs/plans/`（2 本）、空になった `docs/superpowers/` を削除
- [ ] `git mv docs/specs/2026-06-30-session-state-observer-plan.md docs/plans/` ほか specs 混入の `*-plan.md` 3 本を移動
- [ ] `git grep -n 'docs/superpowers\|observer-plan\|persistence-plan\|phase2-plan'` で相互参照を洗い、移動後のパスに更新
- [ ] Commit: `docs: 設計文書を docs/specs、実装計画を docs/plans に統一（docs/superpowers 廃止）`

### Task 2: LICENSE (MIT)

- [ ] 標準 MIT 全文、`Copyright (c) 2026 masaharu432` で `LICENSE` を作成
- [ ] README 末尾にライセンス節（両言語版）
- [ ] Commit: `chore: MIT LICENSE を追加`

### Task 3: README 日英化

- [ ] `README.md`（日本語・現行）の冒頭に言語リンク `日本語 | [English](README.en.md)` を追加
- [ ] `README.en.md` を新規作成 — 現行 README の忠実な英訳（対処表・機能・セットアップ・プラグイン一覧）。相互リンク。
- [ ] Commit: `docs: 英語版 README を追加し相互リンク`

### Task 4: 最終検証

- [ ] 個人情報スキャン: 全履歴 `git grep -IiE '<pattern>' $(git rev-list --all)`（ヒットは `h.ts.net` プレースホルダと author 名のみであること）
- [ ] `./gradlew :app:testDebugUnitTest :app:assembleDebug` 無影響確認
- [ ] Commit（残があれば）+ 完了報告。フェーズ 4（GitHub 公開）はユーザーの合図待ち（public リポジトリ作成は外向きアクションのため）
