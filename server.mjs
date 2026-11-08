// model-proxy · 内核
// 纯 Node，零框架（除 yaml 解析）。既可以被 Electron 壳 import，也可以 `node server.mjs` 单独跑。
// 只做三件事：
//   1) 接收 Claude Code 的 Anthropic 请求，改写 model，注入鉴权头后转发到后端
//   2) 补一个 /v1/models 模型发现接口（Claude Code 的 /model 选择器用）
//   3) 提供本地控制台页面 + /api/* 控制接口（选模型 / 看日志 / 看 token 状态）

import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildBackendRequest, buildFrontendResponse, streamToFrontend } from './translate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MODEL_PROXY_CONFIG || join(__dirname, 'config.yaml');
const STATE_PATH = process.env.MODEL_PROXY_STATE || join(__dirname, 'state.json');
const PANEL_PATH = join(__dirname, 'panel.html');
const ANTHROPIC_VERSION = '2023-06-01';
// 发现接口别名前缀：Claude Code 只保留 id 里含 "claude"/"anthropic" 的模型，
// 所以给你的模型统一加这个前缀绕过过滤；display_name 才是界面上看到的漂亮名字。
const ALIAS_PREFIX = 'anthropic/';
const MAX_BODY = 50 * 1024 * 1024;

let config = loadConfig();
let state = loadState();
const logs = []; // 最近请求日志（内存环形，面板轮询显示）
const latencies = {}; // fullId -> { ms, status, ts }（测速结果，面板轮询显示）
let hintHeadersSeen = false; // 是否检测到客户端请求分类提示头（智能路由依赖）

function loadConfig() {
  return parseYaml(readFileSync(CONFIG_PATH, 'utf8'));
}
function loadState() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) || {}; } catch { return {}; }
  }
  return {};
}

// ---------- 用量统计 ----------
// usage[YYYY-MM-DD] = { models: { fullId: {req,in,out} }, classes: { main/subagent/...: {...} } }
const USAGE_PATH = process.env.MODEL_PROXY_USAGE || join(__dirname, 'usage.json');
let usage = (() => { try { return JSON.parse(readFileSync(USAGE_PATH, 'utf8')) || {}; } catch { return {}; } })();
let usageDirty = false, usageLastFlush = 0;
function flushUsage(force) {
  if (!usageDirty) return;
  const now = Date.now();
  if (!force && now - usageLastFlush < 5000) return;
  usageLastFlush = now; usageDirty = false;
  try {
    const days = Object.keys(usage).sort();
    while (days.length > 90) delete usage[days.shift()]; // 只保留最近 90 天
    writeFileSync(USAGE_PATH, JSON.stringify(usage));
  } catch { /* ignore */ }
}
function recordUsage(model, cls, inputTokens, outputTokens) {
  inputTokens = Number(inputTokens) || 0;
  outputTokens = Number(outputTokens) || 0;
  if (!inputTokens && !outputTokens) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = (usage[day] = usage[day] || { models: {}, classes: {} });
  for (const [key, bucket] of [[model, d.models], [cls || 'unknown', d.classes]]) {
    const b = (bucket[key] = bucket[key] || { req: 0, in: 0, out: 0 });
    b.req += 1; b.in += inputTokens; b.out += outputTokens;
  }
  usageDirty = true;
  flushUsage(false);
}
setInterval(() => flushUsage(true), 15000).unref?.();

// 由控制台写回 config.yaml 时使用的文件头注释
const CONFIG_HEADER = '# model-proxy · 配置文件\n# 监听地址 / api-key / 各 provider 鉴权都可以在控制台「设置」里改，也可以手改本文件。\n# 注意：本文件含明文密钥，请勿外传。\n\n';

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

// ---------- 智能路由 ----------
// Claude Code 开启 CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 后，每个请求都带
// x-claude-code-request-class（main/subagent/workflow/compaction/auxiliary）。
// 路由只作用于「落到默认模型」的请求；显式选择的模型（别名或 provider/id）永远优先。
function getRouting() {
  return config.server?.routing || {};
}
function classModel(cls) {
  const r = getRouting();
  if (!r.enabled) return null;
  if (cls === 'subagent' || cls === 'workflow') return r.subagentModel || null;
  if (cls === 'auxiliary' || cls === 'compaction') return r.auxiliaryModel || null;
  return null; // main / 未知分类 → 默认模型
}

// 决定本次请求最终用哪个模型：
//   1) 带别名前缀（/model 选择器选的）→ 显式命中
//   2) 直接是 "provider/modelId" 且能解析 → 显式命中
//   3) 否则 → 面板默认；若客户端带了请求分类提示头且智能路由开启，按类改写
function pickTarget(requestModel, cls) {
  const viaAlias = fullIdFromAlias(requestModel);
  if (viaAlias) { try { return resolveModel(viaAlias); } catch { /* 落到默认 */ } }
  if (requestModel && requestModel.includes('/')) {
    try { return resolveModel(requestModel); } catch { /* 落到默认 */ }
  }
  let s = selectedFullId();
  if (cls) {
    const r = classModel(cls);
    if (r) { try { resolveModel(r); s = r; } catch { /* 路由目标失效则退回默认 */ } }
  }
  if (!s) throw new Error('没有可用模型，请检查 config.yaml 的 providers');
  return resolveModel(s);
}

// ---------- JWT 过期时间（逐个 provider 统计）----------
function tokensExpiry() {
  const out = [];
  for (const [pid, p] of allProviders()) {
    const m = (p.headers?.Authorization || '').match(/Bearer\s+([A-Za-z0-9\-_.]+)/);
    if (!m) continue;
    try {
      const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
      if (payload.exp) out.push({ providerId: pid, displayName: p.displayName || pid, exp: payload.exp, remainingMs: payload.exp * 1000 - Date.now() });
    } catch { /* ignore */ }
  }
  return out;
}

// ---------- 转发 ----------
function providerProtocol(provider) {
  return (provider.protocol || 'anthropic').toLowerCase();
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// 对后端发一次裸请求（测速/模型发现用），带 provider 自己的鉴权头
function upstreamCall(provider, method, url, body) {
  return new Promise((resolve) => {
    try {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;
      const headers = { ...(provider.headers || {}) };
      if (body) headers['content-type'] = 'application/json';
      const req = transport.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: target.pathname + target.search,
        method, headers, timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ status: 'ERR', body: e.message }));
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch (e) { resolve({ status: 'ERR', body: e.message }); }
  });
}

// 模型发现端点：优先 discoveryURL（如 CANNBot 的 openai 兼容端点），否则按协议推导
function modelsEndpoint(provider) {
  if (provider.discoveryURL) return provider.discoveryURL.replace(/\/+$/, '') + '/models';
  const base = (provider.baseURL || '').replace(/\/+$/, '');
  return providerProtocol(provider) === 'openai' ? base + '/models' : base + '/v1/models';
}

// 从响应文本里取最后一个 "usage" 对象。括号配平解析：兼容嵌套字段
// （真实后端的 usage 可能带 server_tool_use:{} 这类嵌套，扁平正则会失配）。
function extractUsageObject(text) {
  const key = '"usage"';
  const idx = text.lastIndexOf(key);
  if (idx < 0) return null;
  let i = idx + key.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== ':') return null;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// 直通路径的用量嗅探：不改动字节流，旁路提取 usage（尽力而为，失败不影响转发）
function snoopUsage(backendProtocol, upRes, model, cls) {
  try {
    if (String(upRes.headers['content-type'] || '').includes('text/event-stream')) {
      // SSE：逐行解析事件流里的 usage（anthropic 在 message_start/message_delta，openai 在最后一个 chunk）
      let buf = '', input = 0, output = 0;
      upRes.on('data', (c) => {
        try {
          buf += c.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const obj = safeJson(line.slice(5).trim());
            if (!obj) continue;
            if (backendProtocol === 'anthropic') {
              if (obj.type === 'message_start') input = obj.message?.usage?.input_tokens ?? input;
              if (obj.type === 'message_delta') output = obj.usage?.output_tokens ?? output;
            } else if (obj.usage) {
              input = obj.usage.prompt_tokens ?? input;
              output = obj.usage.completion_tokens ?? output;
            }
          }
        } catch { /* ignore */ }
      });
      upRes.on('end', () => recordUsage(model, cls, input, output));
    } else {
      // 非流式：JSON 尾部取最后一个 usage 对象（两协议的 usage 都在 body 末尾附近）
      let tail = '';
      upRes.on('data', (c) => { tail += c.toString('utf8'); if (tail.length > 65536) tail = tail.slice(-32768); });
      upRes.on('end', () => {
        try {
          const u = extractUsageObject(tail) || {};
          recordUsage(model, cls,
            backendProtocol === 'anthropic' ? u.input_tokens : u.prompt_tokens,
            backendProtocol === 'anthropic' ? u.output_tokens : u.completion_tokens);
        } catch { /* ignore */ }
      });
    }
  } catch { /* ignore */ }
}

function readResponseBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// 泛化转发：backendBody 已是「后端协议」格式。同协议直通，跨协议翻译响应/流。
function forward(target, frontendProtocol, backendBody, clientReq, clientRes, cls) {
  const backendProtocol = providerProtocol(target.provider);
  const base = (target.provider.baseURL || '').replace(/\/+$/, '');
  const upstreamPath = backendProtocol === 'openai'
    ? base + '/chat/completions'
    : base + '/v1/messages';
  const u = new URL(upstreamPath);
  const headers = {
    'content-type': 'application/json',
    ...(target.provider.headers || {}),
  };
  if (backendProtocol === 'anthropic') {
    headers['anthropic-version'] = clientReq.headers['anthropic-version'] || ANTHROPIC_VERSION;
    if (clientReq.headers['anthropic-beta']) headers['anthropic-beta'] = clientReq.headers['anthropic-beta'];
  }
  const isStream = backendBody.stream === true;
  const started = Date.now();
  const model = `${target.providerId}/${target.modelId}`;
  const transport = u.protocol === 'http:' ? http : https;

  const upstream = transport.request({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: u.pathname + u.search,
    method: 'POST',
    headers,
  }, async (upRes) => {
    const status = upRes.statusCode || 502;
    // 后端报错：原样透传（错误格式各异，客户端自行读取 message）
    if (status >= 400) {
      clientRes.writeHead(status, upRes.headers);
      upRes.pipe(clientRes);
      upRes.on('end', () => addLog({ ts: Date.now(), model, status, ms: Date.now() - started, cls }));
      return;
    }
    try {
      // 同协议：完全直通，保持与旧版一致的行为（旁路嗅探用量，不动字节流）
      if (frontendProtocol === backendProtocol) {
        clientRes.writeHead(status, upRes.headers);
        snoopUsage(backendProtocol, upRes, model, cls);
        upRes.pipe(clientRes);
        upRes.on('end', () => addLog({ ts: Date.now(), model, status, ms: Date.now() - started, cls }));
        return;
      }
      if (isStream) {
        clientRes.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        await streamToFrontend(frontendProtocol, backendProtocol, upRes, clientRes, target.modelId, (i, o) => recordUsage(model, cls, i, o));
        addLog({ ts: Date.now(), model, status, ms: Date.now() - started, cls });
        clientRes.end();
      } else {
        const bodyStr = await readResponseBody(upRes);
        const parsed = safeJson(bodyStr);
        let out = parsed;
        if (parsed && typeof parsed === 'object') {
          try { out = buildFrontendResponse(frontendProtocol, backendProtocol, parsed); } catch { out = parsed; }
        }
        // 用量统计：从翻译后的响应提取（前端协议的 usage 字段形状）
        try {
          const uu = (out && out.usage) || {};
          recordUsage(model, cls,
            frontendProtocol === 'openai' ? uu.prompt_tokens : uu.input_tokens,
            frontendProtocol === 'openai' ? uu.completion_tokens : uu.output_tokens);
        } catch { /* ignore */ }
        clientRes.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        clientRes.end(typeof out === 'string' ? out : JSON.stringify(out));
        addLog({ ts: Date.now(), model, status, ms: Date.now() - started, cls });
      }
    } catch (e) {
      addLog({ ts: Date.now(), model, status: 'ERR', ms: Date.now() - started, err: e.message, cls });
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: e.message } }));
    }
  });
  upstream.on('error', (e) => {
    addLog({ ts: Date.now(), model, status: 'ERR', ms: Date.now() - started, err: e.message, cls });
    if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: e.message } }));
  });
  upstream.write(JSON.stringify(backendBody));
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
function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function authOk(req) {
  const key = config.server?.apiKey;
  if (!key) return true; // 未配置 = 模型接口不要求鉴权
  const given = req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return given === key;
}

// 管理接口鉴权：本机 loopback 始终可信（面板）；远程访问才要求对外 api-key
function adminOk(req) {
  if (isLoopback(req)) return true;
  const key = config.server?.apiKey;
  if (!key) return false; // 未配 key 时，远程管理一律拒绝
  return authOk(req);
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 各前端协议共用的补全入口：鉴权 → 选模型（含智能路由）→ 翻译成后端协议 → 转发
async function handleCompletion(frontendProtocol, req, res) {
  if (!authOk(req)) return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } });
  // Claude Code 开 CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 后会带请求分类提示头，智能路由据此分流
  const cls = String(req.headers['x-claude-code-request-class'] || '').toLowerCase() || null;
  if (cls) hintHeadersSeen = true;
  let bodyStr;
  try { bodyStr = await readBody(req); } catch (e) { return json(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: e.message } }); }
  let body;
  try { body = JSON.parse(bodyStr); } catch { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid json body' } }); }
  let target;
  try { target = pickTarget(body.model, cls); } catch (e) { return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } }); }
  let backendBody;
  try {
    backendBody = buildBackendRequest(frontendProtocol, providerProtocol(target.provider), body, target.modelId);
  } catch (e) {
    return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } });
  }
  return forward(target, frontendProtocol, backendBody, req, res, cls);
}

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  try {
    if (path === '/' && req.method === 'GET') {
      let html = readFileSync(PANEL_PATH, 'utf8');
      // 主题持久化在 state.json，渲染前注入到 <body>，避免首屏闪烁
      if (state.theme === 'light') html = html.replace('<body>', '<body class="light">');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (path === '/v1/models' && req.method === 'GET') {
      // Claude Code 会带 anthropic-version 头；OpenAI/Codex 不带，据此区分返回形状
      if (req.headers['anthropic-version']) {
        const data = providerModels().map((m) => ({
          id: aliasFor(m.fullId),
          display_name: m.name,
          description: `${m.providerName} · ${m.contextWindow ? (m.contextWindow / 1024) + 'K' : '—'}`,
        }));
        return json(res, 200, { data, has_more: false });
      }
      const data = providerModels().map((m) => ({
        id: m.fullId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.providerName,
      }));
      return json(res, 200, { object: 'list', data });
    }

    if (path === '/v1/messages' && req.method === 'POST') {
      return handleCompletion('anthropic', req, res);
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      return handleCompletion('openai', req, res);
    }

    if (path === '/v1/responses' && req.method === 'POST') {
      return handleCompletion('openai-responses', req, res);
    }

    if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
      let bodyStr; try { bodyStr = await readBody(req); } catch { bodyStr = ''; }
      return json(res, 200, { input_tokens: Math.max(1, Math.round(bodyStr.length / 4)) });
    }

    if (path.startsWith('/api/') && path !== '/api/hello') {
      // 管理接口：本机 loopback 始终可信；远程访问才要求对外 api-key
      if (!adminOk(req)) return json(res, 401, { error: '需要 api-key（在设置里配置的那个）' });

      if (path === '/api/state' && req.method === 'GET') {
        const tokens = tokensExpiry();
        const soonest = tokens.length ? tokens.reduce((a, b) => (b.remainingMs < a.remainingMs ? b : a)) : null;
        return json(res, 200, {
          server: {
            host: config.server?.host || '127.0.0.1',
            port: config.server?.port || 8787,
            apiKeyConfigured: !!config.server?.apiKey,
          },
          selected: selectedFullId(),
          models: providerModels().map((m) => ({ ...m, alias: aliasFor(m.fullId) })),
          providers: allProviders().map(([id, p]) => ({ id, displayName: p.displayName || id, baseURL: p.baseURL })),
          tokens,
          token: soonest,
          latencies,
          routing: {
            enabled: !!getRouting().enabled,
            subagentModel: getRouting().subagentModel || null,
            auxiliaryModel: getRouting().auxiliaryModel || null,
            hintHeadersSeen,
          },
        });
      }
      if (path === '/api/settings' && req.method === 'GET') {
        const providers = {};
        for (const [pid, p] of allProviders()) {
          providers[pid] = {
            displayName: p.displayName || pid,
            protocol: providerProtocol(p),
            baseURL: p.baseURL || '',
            headers: p.headers || {},
            models: (p.models || []).map((m) => m.id),
          };
        }
        return json(res, 200, {
          server: {
            host: config.server?.host || '127.0.0.1',
            port: config.server?.port || 8787,
            apiKey: config.server?.apiKey || '',
          },
          routing: {
            enabled: !!getRouting().enabled,
            subagentModel: getRouting().subagentModel || '',
            auxiliaryModel: getRouting().auxiliaryModel || '',
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
          if (typeof val.displayName === 'string' && val.displayName.trim()) p.displayName = val.displayName.trim();
          const proto = String(val.protocol || '').toLowerCase();
          if (proto === 'anthropic' || proto === 'openai') p.protocol = proto;
          if (typeof val.baseURL === 'string' && val.baseURL.trim()) p.baseURL = val.baseURL.trim();
          // headers 整体替换（过滤空键）；未传 headers 则不动（防止旧客户端误清空）
          if (val.headers && typeof val.headers === 'object') {
            const headers = {};
            for (const [k, v] of Object.entries(val.headers)) {
              const key = String(k).trim();
              if (key) headers[key] = String(v ?? '');
            }
            p.headers = headers;
          }
        }
        // 智能路由设置（模型 id 会校验；无效则整体回滚）
        if (b.routing && typeof b.routing === 'object') {
          const r = { enabled: !!b.routing.enabled };
          for (const k of ['subagentModel', 'auxiliaryModel']) {
            const v = String(b.routing[k] || '').trim();
            if (v) {
              try { resolveModel(v); } catch (e) {
                config = snapshot;
                return json(res, 400, { error: `路由模型无效（${k}）: ${v}` });
              }
              r[k] = v;
            }
          }
          config.server.routing = r;
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
      if (path === '/api/ping' && req.method === 'POST') {
        // 模型测速：对每个模型发一个 max_tokens=1 的最小请求，并行探测并记录延迟
        const results = {};
        await Promise.all(providerModels().map(async (m) => {
          const p = config.providers[m.providerId];
          const base = (p.baseURL || '').replace(/\/+$/, '');
          const ep = providerProtocol(p) === 'openai' ? '/chat/completions' : '/v1/messages';
          const t0 = Date.now();
          const r = await upstreamCall(p, 'POST', base + ep, { model: m.modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
          const rec = { ms: Date.now() - t0, status: r.status, ts: Date.now() };
          latencies[m.fullId] = rec;
          results[m.fullId] = rec;
        }));
        return json(res, 200, { ok: true, results });
      }
      if (path === '/api/discover' && req.method === 'POST') {
        // 从后端拉取模型列表（只读，不落盘）
        const b = JSON.parse(await readBody(req));
        const p = config.providers?.[b.provider];
        if (!p) return json(res, 400, { error: `未知 provider: ${b.provider}` });
        const r = await upstreamCall(p, 'GET', modelsEndpoint(p));
        if (r.status !== 200) return json(res, 502, { error: `后端返回 ${r.status}: ${String(r.body).slice(0, 200)}` });
        const parsed = safeJson(r.body) || {};
        const ids = (Array.isArray(parsed.data) ? parsed.data : []).map((d) => d && d.id).filter((x) => typeof x === 'string' && x);
        const existing = new Set((p.models || []).map((m) => m.id));
        return json(res, 200, { provider: b.provider, found: ids, existing: ids.filter((x) => existing.has(x)), new: ids.filter((x) => !existing.has(x)) });
      }
      if (path === '/api/discover/apply' && req.method === 'POST') {
        // 把选中的新模型写进 config.yaml
        const b = JSON.parse(await readBody(req));
        const p = config.providers?.[b.provider];
        if (!p) return json(res, 400, { error: `未知 provider: ${b.provider}` });
        p.models = p.models || [];
        const have = new Set(p.models.map((m) => m.id));
        const added = [];
        for (const id of Array.isArray(b.add) ? b.add : []) {
          const mid = String(id).trim();
          if (!mid || have.has(mid)) continue;
          p.models.push({ id: mid, name: mid, contextWindow: 0 });
          have.add(mid);
          added.push(mid);
        }
        try { writeFileSync(CONFIG_PATH, CONFIG_HEADER + stringifyYaml(config), 'utf8'); } catch (e) { return json(res, 500, { error: '写 config.yaml 失败: ' + e.message }); }
        return json(res, 200, { ok: true, added, models: p.models.map((m) => m.id) });
      }
      if (path === '/api/usage' && req.method === 'GET') {
        // 用量统计：默认聚合最近 7 天
        flushUsage(true);
        const days = Math.min(parseInt(u.searchParams.get('days') || '7', 10) || 7, 90);
        const keys = Object.keys(usage).sort().slice(-days);
        const byDay = {};
        const totals = { models: {}, classes: {}, req: 0, in: 0, out: 0 };
        for (const k of keys) {
          byDay[k] = JSON.parse(JSON.stringify(usage[k]));
          for (const grp of ['models', 'classes']) {
            for (const [id, v] of Object.entries(usage[k][grp] || {})) {
              const t = (totals[grp][id] = totals[grp][id] || { req: 0, in: 0, out: 0 });
              t.req += v.req; t.in += v.in; t.out += v.out;
            }
          }
          for (const v of Object.values(usage[k].models || {})) { totals.req += v.req; totals.in += v.in; totals.out += v.out; }
        }
        return json(res, 200, { days: keys, byDay, totals });
      }
      if (path === '/api/select' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        try { resolveModel(b.model); } catch (e) { return json(res, 400, { error: e.message }); }
        state.selectedModel = b.model;
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        return json(res, 200, { ok: true, selected: b.model });
      }
      if (path === '/api/theme' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        state.theme = b.theme === 'light' ? 'light' : 'dark';
        writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        return json(res, 200, { ok: true, theme: state.theme });
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
      console.log(`✅ model-proxy 已启动: http://${host}:${port}`);
      console.log(`   控制台: http://${host}:${port}/`);
      console.log(`   Claude Code 请把 ANTHROPIC_BASE_URL 指向 http://${host}:${port}`);
      console.log(`   当前默认模型: ${selectedFullId()}`);
      resolve();
    });
  });
}

// 孤儿保护：桌面壳（app.py）用 stdin 管道 + MODEL_PROXY_PARENT=1 拉起本进程；
// 壳一退出 stdin 即关闭，本进程自动退出，不会残留占着端口。
if (process.env.MODEL_PROXY_PARENT === '1' && process.stdin) {
  process.stdin.resume();
  process.stdin.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => { });
}

// 直接 `node server.mjs` 运行（含被桌面壳拉起）时自动启动。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
}