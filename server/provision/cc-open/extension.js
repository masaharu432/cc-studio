// cc-open — チャットのファイルリンクを Explorer と同じ既定エディタ（関連付け尊重＝.md はプレビュー）で開く補助拡張。
//
// 2経路（フロントは URI を使う。自動変換は保険）:
//  (1) URI ハンドラ: code-oss://ccstudio.cc-open/open?path=<相対 or 絶対>&line=<n> を受け、vscode.open で開く。
//      vscode.open は既定エディタ（editorAssociations 尊重）＝ *.md はプレビュー、他は通常エディタ。最初から
//      プレビューで開けるのでテキストのチラつきが無い。
//  (2) 自動変換（保険）: 何らかの理由で .md がテキストエディタで開かれたら、そのタブを閉じてプレビューで開き直す。
const vscode = require('vscode');

function resolveTarget(p) {
  if (!p) return null;
  if (p.charAt(0) === '/' || /^[a-zA-Z]:[\\/]/.test(p)) return vscode.Uri.file(p);
  const wf = vscode.workspace.workspaceFolders;
  if (wf && wf.length) return vscode.Uri.joinPath(wf[0].uri, p.replace(/^\.?\//, ''));
  return vscode.Uri.file(p);
}

function activate(context) {
  // (1) URI ハンドラ
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      try {
        const params = new URLSearchParams(uri.query || '');
        const target = resolveTarget(params.get('path'));
        if (!target) return;
        const line = parseInt(params.get('line') || '', 10);
        const options = {};
        if (!isNaN(line) && line > 0) {
          const pos = new vscode.Position(line - 1, 0);
          options.selection = new vscode.Range(pos, pos);
        }
        vscode.commands.executeCommand('vscode.open', target, options);
      } catch (e) { /* noop */ }
    },
  }));

  // (2) 自動変換: .md テキストエディタ → その場でプレビュー（既定エディタ）へ切替。
  //   toggleEditorType は同一タブを text↔custom editor で切り替える 1 操作なので、close+open より滑らか
  //   （タブが消えて再オープンしない）。プレビュー(custom editor)になれば onDidChangeActiveTextEditor は
  //   undefined になり再入しない。保険で busy ガードも持つ。
  // cc-open は markdown 専用。HTML は専用拡張 aios-html-auto-preview が担当する
  //   （htmlPreview.enabled 設定 / "AIOS: Toggle HTML Auto-Preview" コマンドで ON/OFF）。二重処理を避ける。
  const busy = new Set();
  async function toPreview(editor) {
    try {
      if (!editor || !editor.document) return;
      const doc = editor.document;
      if (doc.languageId !== 'markdown') return;
      if (!vscode.workspace.getConfiguration('cc-open').get('autoPreview.markdown', true)) return;   // 既定 ON
      if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-remote') return;
      const key = doc.uri.toString();
      if (busy.has(key)) return;
      busy.add(key);
      try {
        await vscode.commands.executeCommand('workbench.action.toggleEditorType');
      } finally { setTimeout(() => busy.delete(key), 1000); }
    } catch (e) { /* noop */ }
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(toPreview));
  toPreview(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate };
