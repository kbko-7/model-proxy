// CANNBot 模型切换代理 · 内核
// 纯 Node，零框架（除 yaml 解析）。既可以被 Electron 壳 import，也可以 `node server.mjs` 单独跑。
// 只做三件事：
//   1) 接收 Claude Code 的 Anthropic 请求，改写 model，注入鉴权头后转发到 CANNBot
//   2) 补一个 /v1/models 模型发现接口（Claude Code 的 /model 选择器用）
//   3) 提供本地控制台页面 + /api/* 控制接口（选模型 / 看日志 / 看 token 状态）

import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.yaml');
const STATE_PATH = join(__dirname, 'state.json');
const PANEL_PATH = join(__dirname, 'panel.html');
const ANTHROPIC_VERSION = '2023-06-01';
// 发现接口别名前缀：Claude Code 只保留 id 里含 "claude"/"anthropic" 的模型，
// 所以给你的模型统一加这个前缀绕过过滤；display_name 才是界面上看到的漂亮名字。
const ALIAS_PREFIX = 'anthropic/';
const MAX_BODY = 50 * 1024 * 1024;

let config = loadConfig();
let state = loadState();
const logs = []; // 最近请求日志（内存环形，面板轮询显示）

function loadConfig() {
  return parseYaml(readFileSync(CONFIG_PATH, 'utf8'));
}
function loadState() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) || {}; } catch { return {}; }
  }
  return {};
}

// 由控制台写回 config.yaml 时使用的文件头注释
const CONFIG_HEADER = '# CANNBot 模型切换代理 · 配置文件\n# 监听地址 / api-key / 各 provider 鉴权都可以在控制台「设置」里改，也可以手改本文件。\n# 注意：本文件含明文密钥，请勿外传。\n\n';

// ---------- 重新监听（设置里改了 host/port 用） ----------
function relisten() {
  return new Promise((resolve, reject) => {
    const doListen = () => {
      const port = config.server?.port || 8787;
      const host = config.server?.host || '127.0.0.1';
      const onError = (e) => { server.off('error', onError); reject(e); };
      server.on('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        console.log(`✅ 已重新监听: http://${host}:${port}`);
        resolve();
      });
    };
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(doListen);
  });
}

// ---------- 模型解析 ----------
function allProviders() {
  return Object.entries(config.providers || {});
}
function providerModels() {
  const out = [];
  for (const [pid, p] of allProviders()) {
    for (const m of p.models || []) {
      out.push({
        fullId: `${pid}/${m.id}`,
        providerId: pid,
        providerName: p.displayName || pid,
        modelId: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow || 0,
      });
    }
  }
  return out;
}
function resolveModel(fullId) {
  const i = (fullId || '').indexOf('/');
  if (i <= 0) throw new Error(`无法解析模型 id: ${fullId}`);
  const pid = fullId.slice(0, i);
  const mid = fullId.slice(i + 1);
  const p = config.providers?.[pid];
  if (!p) throw new Error(`未知 provider: ${pid}`);
  return { providerId: pid, modelId: mid, provider: p };
}
function selectedFullId() {
  return state.selectedModel
    || config.server?.selectedModel
    || (() => { const [pid, p] = allProviders()[0] || []; return p?.models?.[0]?.id ? `${pid}/${p.models[0].id}` : null; })();
}
function aliasFor(fullId) { return ALIAS_PREFIX + fullId; }
function fullIdFromAlias(alias) {
  return alias && alias.startsWith(ALIAS_PREFIX) ? alias.slice(ALIAS_PREFIX.length) : null;
}

// 决定本次请求最终用哪个模型：
//   1) 带别名前缀（/model 选择器选的）→ 显式命中
//   2) 直接是 "provider/modelId" 且能解析 → 显式命中
//   3) 否则 → 用面板里的默认（App 内选）
function pickTarget(requestModel) {
  const viaAlias = fullIdFromAlias(requestModel);
  if (viaAlias) { try { return resolveModel(viaAlias); } catch { /* 落到默认 */ } }
  if (requestModel && requestModel.includes('/')) {
    try { return resolveModel(requestModel); } catch { /* 落到默认 */ }
  }
  const s = selectedFullId();
  if (!s) throw new Error('没有可用模型，请检查 config.yaml 的 providers');
  return resolveModel(s);
}

// ---------- JWT 过期时间 ----------
function tokenExpiry() {
  for (const p of Object.values(config.providers || {})) {
    const m = (p.headers?.Authorization || '').match(/Bearer\s+([A-Za-z0-9\-_.]+)/);
    if (m) {
      try {
        const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
        if (payload.exp) return { exp: payload.exp, remainingMs: payload.exp * 1000 - Date.now() };
      } catch { /* ignore */ }
    }
  }
  return null;
}

// ---------- 转发 ----------
function forwardToProvider(target, bodyStr, clientReq, clientRes) {
  const u = new URL(target.provider.baseURL);
  const headers = {
    'content-type': clientReq.headers['content-type'] || 'application/json',
    'authorization': target.provider.headers?.Authorization || '',
    'x-api-vkey': target.provider.headers?.['x-api-vkey'] || '',
    'anthropic-version': clientReq.headers['anthropic-version'] || ANTHROPIC_VERSION,
  };
  if (clientReq.headers['anthropic-beta']) headers['anthropic-beta'] = clientReq.headers['anthropic-beta'];

  const started = Date.now();
  const upstream = https.request({
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname.replace(/\/$/, '') + '/v1/messages',
    method: 'POST',
    headers,
  }, (upRes) => {
    clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(clientRes);
    upRes.on('end', () => {
      addLog({ ts: Date.now(), model: `${target.providerId}/${target.modelId}`, status: upRes.statusCode, ms: Date.now() - started });
    });
  });
  upstream.on('error', (e) => {
    addLog({ ts: Date.now(), model: `${target.providerId}/${target.modelId}`, status: 'ERR', ms: Date.now() - started, err: e.message });
    if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: e.message } }));
  });
  upstream.write(bodyStr);
  upstream.end();
}

function addLog(entry) {
  logs.unshift(entry);
  if (logs.length > 300) logs.length = 300;
}

// ---------- 请求读取 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 对外鉴权 ----------
function authOk(req) {
  const key = config.server?.apiKey;
  if (!key) return true; // 未配置 = 仅信任本机
  const given = req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return given === key;
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  try {
    if (path === '/' && req.method === 'GET') {
      const html = readFileSync(PANEL_PATH, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (path === '/v1/models' && req.method === 'GET') {
      const data = providerModels().map((m) => ({
        id: aliasFor(m.fullId),
        display_name: m.name,
        description: `${m.providerName} · ${m.contextWindow ? (m.contextWindow / 1024) + 'K' : '—'}`,
      }));
      return json(res, 200, { data, has_more: false });
    }

    if (path === '/v1/messages' && req.method === 'POST') {
      if (!authOk(req)) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } });
      let bodyStr;
      try { bodyStr = await readBody(req); } catch (e) { return json(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: e.message } }); }
      let body;
      try { body = JSON.parse(bodyStr); } catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid json body' } }); }
      let target;
      try { target = pickTarget(body.model); } catch (e) { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } }); }
      body.model = target.modelId; // 改写成上游真实模型 id
      return forwardToProvider(target, JSON.stringify(body), req, res);
    }

    if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
      let bodyStr; try { bodyStr = await readBody(req); } catch { bodyStr = ''; }
      return json(res, 200, { input_tokens: Math.max(1, Math.round(bodyStr.length / 4)) });
    }

    if (path.startsWith('/api/') && path !== '/api/hello') {
      // 设置了对外 api-key 后，控制接口也要带同值（GET / 面板本身除外）
      if (!authOk(req)) return json(res, 401, { error: '需要 api-key（在设置里配置的那个）' });

      if (path === '/api/state' && req.method === 'GET') {
        const exp = tokenExpiry();
        return json(res, 200, {
          server: {
            host: config.server?.host || '127.0.0.1',
            port: config.server?.port || 8787,
            apiKeyConfigured: !!config.server?.apiKey,
          },
          selected: selectedFullId(),
          models: providerModels().map((m) => ({ ...m, alias: aliasFor(m.fullId) })),
          providers: allProviders().map(([id, p]) => ({ id, displayName: p.displayName || id, baseURL: p.baseURL })),
          token: exp ? { exp: exp.exp, remainingMs: exp.remainingMs } : null,
        });
      }
      if (path === '/api/settings' && req.method === 'GET') {
        const providers = {};
        for (const [pid, p] of allProviders()) {
          providers[pid] = {
            displayName: p.displayName || pid,
            authorization: (p.headers?.Authorization || '').replace(/^Bearer\s+/i, ''),
            vkey: p.headers?.['x-api-vkey'] || '',
          };
        }
        return json(res, 200, {
          server: {
            host: config.server?.host || '127.0.0.1',
            port: config.server?.port || 8787,
            apiKey: config.server?.apiKey || '',
          },
          providers,
        });
      }
      if (path === '/api/settings' && req.method === 'PUT') {
        const b = JSON.parse(await readBody(req));
        const host = String(b.server?.host || '').trim() || '127.0.0.1';
        const port = parseInt(b.server?.port, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { error: '端口必须是 1-65535 之间的整数' });
        const apiKey = String(b.server?.apiKey || '').trim();
        const oldHost = config.server?.host || '127.0.0.1';
        const oldPort = config.server?.port || 8787;
        const snapshot = JSON.parse(JSON.stringify(config)); // 失败回滚用

        config.server = { ...(config.server || {}), host, port, apiKey };
        for (const [pid, val] of Object.entries(b.providers || {})) {
          const p = config.providers?.[pid];
          if (!p) continue;
          p.headers = p.headers || {};
          const auth = String(val.authorization || '').trim();
          // 留空 = 保持原值不动（防止误清空）；要清除请手改 config.yaml
          if (auth) p.headers.Authorization = /^Bearer\s/i.test(auth) ? auth : 'Bearer ' + auth;
          const vk = String(val.vkey || '').trim();
          if (vk) p.headers['x-api-vkey'] = vk;
        }
        try {
          writeFileSync(CONFIG_PATH, CONFIG_HEADER + stringifyYaml(config), 'utf8');
        } catch (e) {
          config = snapshot;
          return json(res, 500, { error: '写 config.yaml 失败: ' + e.message });
        }
        if (host !== oldHost || port !== oldPort) {
          const panelHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
          json(res, 200, { ok: true, moved: { host, port, url: `http://${panelHost}:${port}/` } });
          // 先把响应发回去，再切换监听；失败自动回滚到旧地址
          setTimeout(async () => {
            try {
              await relisten();
            } catch (e) {
              console.error('新地址监听失败，回滚:', e.message);
              config = snapshot;
              try { writeFileSync(CONFIG_PATH, CONFIG_HEADER + stringifyYaml(config), 'utf8'); } catch { }
              try { await relisten(); } catch (e2) { console.error('回滚监听也失败:', e2.message); }
            }
          }, 600);
          return;
        }
        return json(res, 200, { ok: true });
      }
      if (path === '/api/select' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        try { resolveModel(b.model); } catch (e) { return json(res, 400, { error: e.message }); }
        state.selectedModel = b.model;
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        return json(res, 200, { ok: true, selected: b.model });
      }
      if (path === '/api/reload' && req.method === 'POST') {
        config = loadConfig();
        state = loadState();
        return json(res, 200, { ok: true, selected: selectedFullId() });
      }
      if (path === '/api/logs' && req.method === 'GET') {
        return json(res, 200, { logs: logs.slice(0, 100) });
      }
    }

    if (path === '/api/hello' && req.method === 'HEAD') {
      res.writeHead(200);
      return res.end();
    }

    json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'not found: ' + path } });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { type: 'error', error: { type: 'proxy_error', message: e.message } });
    else res.end();
  }
});
// 兜底捕获监听错误（如端口被占用），避免进程直接崩掉
server.on('error', (e) => console.error('HTTP server error:', e.message));

export function startServer() {
  const port = config.server?.port || 8787;
  const host = config.server?.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`✅ CANNBot 模型代理已启动: http://${host}:${port}`);
      console.log(`   控制台: http://${host}:${port}/`);
      console.log(`   Claude Code 请把 ANTHROPIC_BASE_URL 指向 http://${host}:${port}`);
      console.log(`   当前默认模型: ${selectedFullId()}`);
      resolve();
    });
  });
}

// 孤儿保护：桌面壳（app.py）用 stdin 管道 + CANNBOT_PROXY_PARENT=1 拉起本进程；
// 壳一退出 stdin 即关闭，本进程自动退出，不会残留占着端口。
if (process.env.CANNBOT_PROXY_PARENT === '1' && process.stdin) {
  process.stdin.resume();
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => { });
}

// 直接 `node server.mjs` 运行（含被桌面壳拉起）时自动启动。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
}