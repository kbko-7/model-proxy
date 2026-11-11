// 联网搜索冒烟测试：起 mock SearXNG + mock Anthropic 后端（先返回 proxy_web_search 工具调用，
// 再返回最终答案），再起真实代理内核，验证「截获 tool_use → 本地搜索 → 回填 → 重发 → 只回最终答案」的闭环。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

let pass = 0, fail = 0;
function ok(name, fn) {
  return fn().then(() => { pass++; console.log('  ✓', name); })
    .catch((e) => { fail++; console.log('  ✗', name, '\n    ', e.message); });
}

function startMock(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => handler(req, b, res));
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

// mock SearXNG：记录命中次数与查询词，返回两条结果
let searchHits = 0, searchQuery = '';
function searxngHandler(req, _body, res) {
  searchHits++;
  searchQuery = new URL(req.url, 'http://x').searchParams.get('q') || '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: [
    { title: 'R1', url: 'http://example.com/1', content: 'first result snippet' },
    { title: 'R2', url: 'http://example.com/2', content: 'second result snippet' },
  ] }));
}

// mock Anthropic 后端：根据「是否已含 tool_result」决定返回工具调用还是最终答案
const capturedBodies = [];
function searchBackend(req, body, res) {
  const b = JSON.parse(body);
  capturedBodies.push(b);
  const msgs = b.messages || [];
  const last = msgs[msgs.length - 1];
  const hasToolResult = last && last.role === 'user' && Array.isArray(last.content)
    && last.content.some((c) => c.type === 'tool_result');

  const stream = b.stream === true;
  if (!hasToolResult) {
    // 第 1 轮：返回 proxy_web_search 工具调用
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'm1', model: b.model, usage: { input_tokens: 5, output_tokens: 0 } } }) + '\n\n');
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_test', name: 'proxy_web_search', input: {} } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"test' } }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' query"}' } }) + '\n\n');
      res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
      res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }) + '\n\n');
      res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'tool_use', id: 'toolu_ns', name: 'proxy_web_search', input: { query: 'ns query' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 4 } }));
    }
    res.end();
    return;
  }
  // 第 2 轮：最终文本答案
  if (stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'm2', model: b.model, usage: { input_tokens: 10, output_tokens: 0 } } }) + '\n\n');
    res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
    res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'search-answer' } }) + '\n\n');
    res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
    res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + '\n\n');
    res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm2', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'search-answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }));
  }
  res.end();
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const searxng = await startMock(searxngHandler);
  const backend = await startMock(searchBackend);

  const dir = mkdtempSync(join(tmpdir(), 'model-proxy-search-'));
  const configPath = join(dir, 'config.yaml');
  const statePath = join(dir, 'state.json');
  writeFileSync(configPath, `server:
  host: 127.0.0.1
  port: 8802
  apiKey: ""
  selectedModel: cannbot/deepseek-v4-pro
search:
  enabled: true
  provider: searxng
  searxngUrl: http://127.0.0.1:${searxng.port}
  maxResults: 3
  maxRounds: 8
providers:
  cannbot:
    displayName: Mock-Anthropic
    protocol: anthropic
    baseURL: http://127.0.0.1:${backend.port}
    headers:
      Authorization: Bearer test
    models:
      - id: deepseek-v4-pro
        name: Mock-Anth-Model
        contextWindow: 128000
`);

  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, MODEL_PROXY_CONFIG: configPath, MODEL_PROXY_STATE: statePath, MODEL_PROXY_USAGE: join(dir, 'usage.json') },
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  proc.stdin.end();
  await new Promise((r) => setTimeout(r, 800));

  const P = 8802;

  try {
    // 1) 流式搜索闭环
    await ok('流式：截获 tool_use → 本地搜索 → 只回最终答案', async () => {
      searchHits = 0;
      capturedBodies.length = 0;
      const r = await post(P, '/v1/messages', { model: 'cannbot/deepseek-v4-pro', messages: [{ role: 'user', content: '最近有什么新闻' }], max_tokens: 10, stream: true });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('search-answer'), '返回最终答案');
      assert.ok(!r.body.includes('proxy_web_search'), '中间 tool_use 未透传给客户端');
      assert.strictEqual(searchHits, 1, 'SearXNG 被命中一次');
      assert.strictEqual(searchQuery, 'test query', '查询词来自工具参数');
      assert.strictEqual(capturedBodies.length, 2, '后端被调用两轮');
      assert.ok(capturedBodies[0].tools.some((t) => t.name === 'proxy_web_search'), '第 1 轮注入了工具');
      const lastMsg = capturedBodies[1].messages[capturedBodies[1].messages.length - 1];
      const tr = lastMsg.content.find((c) => c.type === 'tool_result');
      assert.ok(tr, '第 2 轮包含 tool_result');
      assert.ok(tr.content.includes('R1'), 'tool_result 内含搜索结果');
    });

    // 2) 非流式搜索闭环
    await ok('非流式：截获 tool_use → 本地搜索 → 只回最终答案', async () => {
      searchHits = 0;
      capturedBodies.length = 0;
      const r = await post(P, '/v1/messages', { model: 'cannbot/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.content[0].text, 'search-answer');
      assert.strictEqual(searchHits, 1);
      assert.strictEqual(capturedBodies.length, 2);
    });

    // 3) 测试搜索接口
    await ok('POST /api/search/test 返回结果', async () => {
      const r = await post(P, '/api/search/test', { query: 'anything' });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.results.length, 2);
      assert.strictEqual(j.results[0].title, 'R1');
    });
  } finally {
    proc.kill();
    searxng.server.close();
    backend.server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
