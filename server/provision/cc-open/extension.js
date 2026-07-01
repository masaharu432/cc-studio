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

  // (2) 自動変換（保険）: .md テキストエディタ → 閉じてプレビューで開き直す。
  const busy = new Set();
  async function toPreview(editor) {
    try {
      if (!editor || !editor.document) return;
      const doc = editor.document;
      if (doc.languageId !== 'markdown') return;
      if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-remote') return;
      const key = doc.uri.toString();
      if (busy.has(key)) return;
      busy.add(key);
      try {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.commands.executeCommand('vscode.open', doc.uri);
      } finally { setTimeout(() => busy.delete(key), 1000); }
    } catch (e) { /* noop */ }
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(toPreview));
  toPreview(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate };
