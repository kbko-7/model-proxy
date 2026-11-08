// 端到端冒烟测试：本地起 mock 后端（OpenAI + Anthropic），再起真实代理内核，
// 验证三种前端协议 x 两种后端协议的路由、请求翻译、响应翻译、流式翻译。
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

// ---- mock 后端 ----
function startMock(name, handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => handler(req, b, res));
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

function anthropicUpstream(req, body, res) {
  const b = JSON.parse(body);
  if (b.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'm1', model: b.model, usage: { input_tokens: 2, output_tokens: 0 } } }) + '\n\n');
    res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
    res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic-echo' } }) + '\n\n');
    res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
    res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + '\n\n');
    res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'anthropic-echo' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } }));
  }
}

function openaiUpstream(req, body, res) {
  const b = JSON.parse(body);
  if (b.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'openai-echo' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: b.model, choices: [{ index: 0, message: { role: 'assistant', content: 'openai-echo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
  }
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

function put(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'PUT', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject).end();
  });
}

// ---- 主流程 ----
async function main() {
  const anthropic = await startMock('anthropic', anthropicUpstream);
  const openai = await startMock('openai', openaiUpstream);

  const dir = mkdtempSync(join(tmpdir(), 'cannbot-proxy-test-'));
  const configPath = join(dir, 'config.yaml');
  const statePath = join(dir, 'state.json');
  writeFileSync(configPath, `server:
  host: 127.0.0.1
  port: 8799
  apiKey: ""
  selectedModel: cannbot/deepseek-v4-pro
providers:
  cannbot:
    displayName: Mock-Anthropic
    protocol: anthropic
    baseURL: http://127.0.0.1:${anthropic.port}
    headers:
      Authorization: Bearer mock
    models:
      - id: deepseek-v4-pro
        name: Mock-Anth-Model
        contextWindow: 128000
  mockopenai:
    displayName: Mock-OpenAI
    protocol: openai
    baseURL: http://127.0.0.1:${openai.port}/v1
    headers:
      Authorization: Bearer mock
    models:
      - id: gpt-mock
        name: Mock-OpenAI-Model
        contextWindow: 128000
`);

  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, CANNBOT_PROXY_CONFIG: configPath, CANNBOT_PROXY_STATE: statePath },
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  proc.stdin.end();
  await new Promise((r) => setTimeout(r, 800));

  const P = 8799;

  try {
    // 1) /v1/models 两种形状
    await ok('/v1/models 返回 Anthropic 形状（带 anthropic-version）', async () => {
      const r = await get(P, '/v1/models', { 'anthropic-version': '2023-06-01' });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.ok(j.data[0].id.startsWith('anthropic/'));
      assert.ok(j.data.some((m) => m.id.includes('mockopenai/gpt-mock')));
    });
    await ok('/v1/models 返回 OpenAI 形状（不带 anthropic-version）', async () => {
      const r = await get(P, '/v1/models', { authorization: 'Bearer x' });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.object, 'list');
      assert.strictEqual(j.data[0].object, 'model');
    });

    // 2) anthropic -> anthropic（直通，非流式）
    await ok('anthropic 前端 -> anthropic 后端 直通', async () => {
      const r = await post(P, '/v1/messages', { model: 'cannbot/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.content[0].text, 'anthropic-echo');
    });

    // 3) anthropic -> openai（翻译）
    await ok('anthropic 前端 -> openai 后端（翻译，非流式）', async () => {
      const r = await post(P, '/v1/messages', { model: 'mockopenai/gpt-mock', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.type, 'message');
      assert.strictEqual(j.content[0].text, 'openai-echo');
    });

    // 4) openai-chat -> openai（直通）
    await ok('openai 前端 -> openai 后端 直通', async () => {
      const r = await post(P, '/v1/chat/completions', { model: 'mockopenai/gpt-mock', messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.choices[0].message.content, 'openai-echo');
    });

    // 5) openai-chat -> anthropic（翻译）
    await ok('openai 前端 -> anthropic 后端（翻译，非流式）', async () => {
      const r = await post(P, '/v1/chat/completions', { model: 'cannbot/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.object, 'chat.completion');
      assert.strictEqual(j.choices[0].message.content, 'anthropic-echo');
    });

    // 6) responses -> openai（翻译）
    await ok('responses 前端 -> openai 后端（翻译，非流式）', async () => {
      const r = await post(P, '/v1/responses', { model: 'mockopenai/gpt-mock', input: 'hi' });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      assert.strictEqual(j.object, 'response');
      assert.strictEqual(j.output[0].content[0].text, 'openai-echo');
    });

    // 7) responses -> anthropic（翻译，流式）
    await ok('responses 前端 -> anthropic 后端（翻译，流式）', async () => {
      const r = await post(P, '/v1/responses', { model: 'cannbot/deepseek-v4-pro', input: 'hi', stream: true });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('response.created'));
      assert.ok(r.body.includes('output_text.delta'));
      assert.ok(r.body.includes('response.completed'));
    });

    // 8) anthropic -> openai（流式翻译）
    await ok('anthropic 前端 -> openai 后端（翻译，流式）', async () => {
      const r = await post(P, '/v1/messages', { model: 'mockopenai/gpt-mock', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, stream: true });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('message_start'));
      assert.ok(r.body.includes('"text":"openai-echo"'));
      assert.ok(r.body.includes('message_stop'));
    });

    // 9) openai-chat -> anthropic（流式翻译）
    await ok('openai 前端 -> anthropic 后端（翻译，流式）', async () => {
      const r = await post(P, '/v1/chat/completions', { model: 'cannbot/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], stream: true });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('chat.completion.chunk'));
      assert.ok(r.body.includes('"content":"anthropic-echo"'));
      assert.ok(r.body.includes('[DONE]'));
    });

    // 10) 设置接口：通用 provider 结构
    await ok('GET /api/settings 返回通用 provider 结构', async () => {
      const r = await get(P, '/api/settings');
      assert.strictEqual(r.status, 200);
      const j = JSON.parse(r.body);
      const c = j.providers.cannbot;
      assert.strictEqual(c.protocol, 'anthropic');
      assert.strictEqual(c.baseURL, `http://127.0.0.1:${anthropic.port}`);
      assert.deepStrictEqual(c.headers, { Authorization: 'Bearer mock' });
      assert.deepStrictEqual(c.models, ['deepseek-v4-pro']);
      assert.strictEqual(j.providers.mockopenai.protocol, 'openai');
    });

    // 11) 设置接口：通用写入
    await ok('PUT /api/settings 通用写入（headers 替换、模型不被误改）', async () => {
      const r = await put(P, '/api/settings', {
        server: { host: '127.0.0.1', port: 8799, apiKey: '' },
        providers: {
          cannbot: { displayName: '改名', protocol: 'openai', baseURL: 'http://127.0.0.1:9/v1', headers: { 'x-custom': 'hi', Authorization: 'Bearer new' } },
          mockopenai: { displayName: 'Mock-OpenAI', protocol: 'openai', baseURL: `http://127.0.0.1:${openai.port}/v1`, headers: { Authorization: 'Bearer mock' } },
        },
      });
      assert.strictEqual(r.status, 200);
      const j = JSON.parse((await get(P, '/api/settings')).body);
      assert.strictEqual(j.providers.cannbot.displayName, '改名');
      assert.strictEqual(j.providers.cannbot.protocol, 'openai');
      assert.deepStrictEqual(j.providers.cannbot.headers, { 'x-custom': 'hi', Authorization: 'Bearer new' });
      assert.deepStrictEqual(j.providers.cannbot.models, ['deepseek-v4-pro']);
    });
  } finally {
    proc.kill();
    anthropic.server.close();
    openai.server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
