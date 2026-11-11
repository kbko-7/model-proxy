// model-proxy · 联网搜索：SearXNG 后端 + Anthropic tool_use 检测（纯函数，无副作用）
// 由 server.mjs 的搜索循环（forwardWithSearch）调用。v1 仅支持 Anthropic 后端。

import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { parseSSE } from './translate.mjs';

// 注入给后端模型的工具名（避免与 Claude Code 自带的 web_search server tool 撞名）
export const SEARCH_TOOL_NAME = 'proxy_web_search';

// Anthropic 平铺格式的工具定义；OpenAI 后端时由 injectWebSearchTool 转成嵌套 function 格式
export const SEARCH_TOOL_DEF = {
  name: SEARCH_TOOL_NAME,
  description: 'Search the web for current, up-to-date information (news, facts, real-time data). Use this when the user asks about recent events or anything beyond your training cutoff. Returns top search results with title, URL, and snippet.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query to look up on the web.' },
    },
    required: ['query'],
  },
};

// 把 proxy_web_search 工具追加进后端请求的 tools 数组（按后端协议格式）。已存在则不动，避免重复注入。
export function injectWebSearchTool(backendBody, backendProtocol) {
  const src = Array.isArray(backendBody.tools) ? backendBody.tools : [];
  const already = src.some((t) => t && (t.name === SEARCH_TOOL_NAME || (t.function && t.function.name === SEARCH_TOOL_NAME)));
  if (already) return backendBody;
  const tools = src.slice();
  if (backendProtocol === 'anthropic') {
    tools.push(SEARCH_TOOL_DEF);
  } else {
    tools.push({ type: 'function', function: { name: SEARCH_TOOL_DEF.name, description: SEARCH_TOOL_DEF.description, parameters: SEARCH_TOOL_DEF.input_schema } });
  }
  backendBody.tools = tools;
  return backendBody;
}

// 从 Anthropic SSE 文本里解析出所有 tool_use 块（含累积的 input_json_delta 参数）。
// 返回 [{ id, name, input }]。
export async function parseAnthropicToolUses(text) {
  const tools = new Map(); // index -> { id, name, input, _json }
  const stream = Readable.from([text]);
  for await (const { data } of parseSSE(stream)) {
    let obj; try { obj = JSON.parse(data); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
      tools.set(obj.index, {
        id: obj.content_block.id || ('toolu_' + Date.now().toString(36)),
        name: obj.content_block.name || '',
        input: (obj.content_block.input && typeof obj.content_block.input === 'object') ? obj.content_block.input : {},
        _json: '',
      });
    } else if (obj.type === 'content_block_delta' && obj.delta?.type === 'input_json_delta') {
      const t = tools.get(obj.index);
      if (t) t._json += (obj.delta.partial_json || '');
    }
  }
  const out = [];
  for (const t of tools.values()) {
    if (t._json) { try { t.input = JSON.parse(t._json); } catch { /* 保留 content_block_start 里的 input */ } }
    delete t._json;
    out.push({ id: t.id, name: t.name, input: t.input });
  }
  return out;
}

// 从 Anthropic 非流式响应消息里提取 tool_use 块（content 数组里 type==='tool_use' 的项）
export function toolUsesFromMessage(msg) {
  const blocks = (msg && Array.isArray(msg.content)) ? msg.content : [];
  return blocks
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: (b.input && typeof b.input === 'object') ? b.input : {} }));
}

// 调 SearXNG JSON 接口搜索。返回 { ok, text, results } 或 { ok:false, error }。
// text 用于填进 tool_result.content；results 为原始数组（面板测试接口展示用）。
export function doSearch(searchCfg, query) {
  const base = String((searchCfg && searchCfg.searxngUrl) || '').replace(/\/+$/, '');
  const maxResults = Math.max(1, Math.min(20, Number(searchCfg?.maxResults) || 5));
  const q = String(query || '').trim();
  if (!base) return Promise.resolve({ ok: false, error: '未配置 SearXNG 地址（searxngUrl）' });
  if (!q) return Promise.resolve({ ok: false, error: '查询词为空' });
  const url = `${base}/search?q=${encodeURIComponent(q)}&format=json`;
  return new Promise((resolve) => {
    try {
      const target = new URL(url);
      const transport = target.protocol === 'http:' ? http : https;
      const req = transport.request({
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: target.pathname + target.search,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'model-proxy/1.0' },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve({ ok: false, error: `SearXNG 返回 ${res.statusCode}` }); return; }
          let parsed; try { parsed = JSON.parse(data); } catch { resolve({ ok: false, error: 'SearXNG 返回非 JSON' }); return; }
          const results = (Array.isArray(parsed.results) ? parsed.results : []).slice(0, maxResults)
            .map((r) => ({
              title: String(r.title || '').trim() || '(无标题)',
              url: String(r.url || '').trim(),
              content: String(r.content || '').replace(/\s+/g, ' ').trim(),
            }));
          if (!results.length) { resolve({ ok: true, text: '（无搜索结果）', results: [] }); return; }
          const lines = results.map((r, i) => {
            const content = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content;
            return `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${content}`;
          });
          resolve({ ok: true, text: lines.join('\n\n'), results });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.end();
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}
