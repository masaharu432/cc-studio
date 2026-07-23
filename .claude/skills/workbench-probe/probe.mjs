#!/usr/bin/env node
// workbench-probe — 稼働中の code-server workbench に headless Chrome (CDP) で入り、
// スマホ相当のエミュレーション・プラグイン注入・HUD 読み取り・スクリーンショット・任意 JS 評価を行う。
// 依存なし（Node 22+ の組み込み WebSocket / fetch を使用）。google-chrome が PATH に必要。
//
// 使い方:
//   node probe.mjs [flags]
//     --url <u>        対象 (既定 http://127.0.0.1:8088)
//     --mobile         スマホ縦画面をエミュレート (412x915 dpr2.625 touch, viewport meta 有効)
//     --settings <js>  window.__ccPluginSettings に入れる JSON (プラグインより先に注入)
//     --plugin <file>  document-start 相当で全フレームに注入する JS (繰り返し可・指定順)
//     --wait <sel>     このセレクタが生えるまで待つ (既定 .monaco-workbench, 最大 60s)
//     --settle <ms>    wait 後の追加待ち (既定 3000。プラグインの 1s tick を跨がせる)
//     --eval <expr>    トップフレームで評価して JSON を出力 (繰り返し可)
//     --hud            window.__ccStudioFocusLog (focus-hud 共有バッファ) を出力
//     --shot <file>    スクリーンショット PNG を保存
//
// 例: ui-zoom を実機同等条件で検証し、HUD とスクショと innerWidth を取る
//   node probe.mjs --mobile \
//     --settings '{"ui-zoom":{"enabled":true,"diag":true}}' \
//     --plugin plugins/ui-zoom.js \
//     --hud --shot /tmp/probe.png --eval 'window.innerWidth'
//
// 認証: ~/.config/code-server/config.yaml の password で /login して session cookie を得る。
// パスワードや cookie はどこにも保存しない。

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 引数 ----
const args = process.argv.slice(2);
const flags = { url: 'http://127.0.0.1:8088', wait: '.monaco-workbench', settle: 3000, plugins: [], evals: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--url') flags.url = args[++i];
  else if (a === '--mobile') flags.mobile = true;
  else if (a === '--settings') flags.settings = args[++i];
  else if (a === '--plugin') flags.plugins.push(args[++i]);
  else if (a === '--wait') flags.wait = args[++i];
  else if (a === '--settle') flags.settle = +args[++i];
  else if (a === '--eval') flags.evals.push(args[++i]);
  else if (a === '--hud') flags.hud = true;
  else if (a === '--shot') flags.shot = args[++i];
  else { console.error('unknown flag: ' + a); process.exit(2); }
}

// ---- code-server ログイン → session cookie ----
async function loginCookie(url) {
  const cfg = readFileSync(join(homedir(), '.config/code-server/config.yaml'), 'utf8');
  const pw = (cfg.match(/^password:\s*(.+)$/m) || [])[1]?.trim();
  if (!pw) throw new Error('password not found in code-server config.yaml');
  const res = await fetch(url.replace(/\/$/, '') + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(pw),
  });
  const set = res.headers.get('set-cookie') || '';
  const m = set.match(/code-server-session=([^;]+)/);
  if (!m) throw new Error('login failed (no session cookie; auth 方式が変わった?)');
  return m[1];
}

// ---- Chrome 起動 ----
const port = 9500 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'cc-probe-'));
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
function cleanup(code) {
  try { chrome.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => cleanup(130));

try {
  // CDP が開くまで待つ
  let ver = null;
  for (let i = 0; i < 50 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!ver) throw new Error('chrome CDP not reachable');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  await send('Network.enable');
  await send('Network.setCookie', { name: 'code-server-session', value: await loginCookie(flags.url), url: flags.url });

  if (flags.mobile) {
    // Pixel 系縦画面相当。mobile:true で viewport meta が有効になる（ui-zoom の縮小も実機同様に働く）。
    await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }

  // 設定 → プラグインの順に document-start 相当で登録（新規ドキュメント全部＝サブフレーム含む。
  // 注意: クロスプロセス iframe (OOPIF) には届かない。code-server は webview 同一オリジンなので実用上足りる）。
  if (flags.settings) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ccPluginSettings = ${flags.settings};` });
  }
  for (const f of flags.plugins) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(f, 'utf8') });
  }

  await send('Page.enable');
  await send('Page.navigate', { url: flags.url });

  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result;
  // wait セレクタ
  let ok = false;
  for (let i = 0; i < 60; i++) {
    const r = await evalJs(`!!document.querySelector(${JSON.stringify(flags.wait)})`);
    if (r.value) { ok = true; break; }
    await new Promise(r2 => setTimeout(r2, 1000));
  }
  if (!ok) console.error(`warn: wait selector not found in 60s: ${flags.wait}`);
  await new Promise(r => setTimeout(r, flags.settle));

  const out = {};
  for (const e of flags.evals) {
    const r = await evalJs(e);
    out[e] = r.exceptionDetails ? { error: r.exceptionDetails?.exception?.description || 'eval error' } : r.value;
  }
  if (flags.hud) out.hud = (await evalJs('(window.__ccStudioFocusLog || []).slice(-40)')).value;
  if (flags.shot) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(flags.shot, Buffer.from(shot.data, 'base64'));
    out.shot = flags.shot;
  }
  console.log(JSON.stringify(out, null, 1));
  cleanup(0);
} catch (e) {
  console.error('probe failed: ' + e.message);
  cleanup(1);
}
