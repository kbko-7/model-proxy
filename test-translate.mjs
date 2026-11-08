import { Readable } from 'node:stream';
import assert from 'node:assert';
import { buildBackendRequest, buildFrontendResponse, streamToFrontend } from './translate.mjs';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n    ', e.message); }
}

function collectStream(streamFn, upChunks, modelId) {
  return new Promise((resolve) => {
    const up = Readable.from(upChunks.map((c) => Buffer.from(c)));
    const chunks = [];
    const clientRes = { write: (s) => chunks.push(s), end: () => {} };
    streamFn(up, clientRes, modelId).then(() => resolve(chunks.join('')));
  });
}

// --- 请求翻译 ---
ok('messages -> chat 基本字段', () => {
  const r = buildBackendRequest('anthropic', 'openai', {
    model: 'x', system: 'sys', max_tokens: 100, temperature: 0.5, stop_sequences: ['a'], stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }, 'gpt-x');
  assert.strictEqual(r.model, 'gpt-x');
  assert.deepStrictEqual(r.messages[0], { role: 'system', content: 'sys' });
  assert.strictEqual(r.messages[1].content, 'hi');
  assert.strictEqual(r.max_tokens, 100);
  assert.deepStrictEqual(r.stop, ['a']);
});

ok('messages -> chat 工具调用', () => {
  const r = buildBackendRequest('anthropic', 'openai', {
    model: 'x', messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'res' }] },
    ],
  }, 'gpt-x');
  assert.deepStrictEqual(r.messages[0].tool_calls, [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]);
  assert.deepStrictEqual(r.messages[1], { role: 'tool', tool_call_id: 't1', content: 'res' });
});

ok('chat -> messages 基本字段', () => {
  const r = buildBackendRequest('openai', 'anthropic', {
    model: 'x', max_tokens: 50, stop: ['a'], stream: false,
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
  }, 'claude-x');
  assert.strictEqual(r.model, 'claude-x');
  assert.strictEqual(r.system, 's');
  assert.deepStrictEqual(r.messages[0], { role: 'user', content: 'hi' });
  assert.deepStrictEqual(r.stop_sequences, ['a']);
});

ok('responses -> chat 指令+输入', () => {
  const r = buildBackendRequest('openai-responses', 'openai', {
    model: 'x', instructions: 'sys', max_output_tokens: 10,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }, 'gpt-x');
  assert.deepStrictEqual(r.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.strictEqual(r.max_tokens, 10);
});

// --- 响应翻译 ---
ok('chat resp -> messages resp', () => {
  const r = buildFrontendResponse('anthropic', 'openai', {
    id: 'c1', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.strictEqual(r.type, 'message');
  assert.strictEqual(r.content[0].text, 'hello');
  assert.strictEqual(r.content[1].type, 'tool_use');
  assert.deepStrictEqual(r.content[1].input, { a: 1 });
  assert.strictEqual(r.stop_reason, 'tool_use');
  assert.deepStrictEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
});

ok('messages resp -> chat resp', () => {
  const r = buildFrontendResponse('openai', 'anthropic', {
    id: 'm1', model: 'claude-x', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'hey' }], usage: { input_tokens: 3, output_tokens: 4 },
  });
  assert.strictEqual(r.object, 'chat.completion');
  assert.strictEqual(r.choices[0].message.content, 'hey');
  assert.strictEqual(r.choices[0].finish_reason, 'stop');
  assert.deepStrictEqual(r.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

ok('chat resp -> responses resp', () => {
  const r = buildFrontendResponse('openai-responses', 'openai', {
    id: 'c1', model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.strictEqual(r.object, 'response');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.output[0].content[0].text, 'hello');
});

// --- 流式翻译 ---
const sse = (event, data) => (event ? `event: ${event}\n` : '') + `data: ${data}\n\n`;

ok('openai 流 -> anthropic 流（文本）', async () => {
  const out = await collectStream(streamToFrontend.bind(null, 'anthropic', 'openai'), [
    'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '你' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) + '\n\n',
    'data: [DONE]\n\n',
  ], 'gpt-x');
  assert.ok(out.includes('event: message_start'), '有 message_start');
  assert.ok(out.includes('text_delta'), '有 text_delta');
  assert.ok(out.includes('"text":"你"') && out.includes('"text":"好"'), '文本内容完整');
  assert.ok(out.includes('message_stop'), '有 message_stop');
  assert.ok(out.includes('"stop_reason":"end_turn"'), 'stop_reason 映射为 end_turn');
});

ok('anthropic 流 -> openai 流（文本）', async () => {
  const out = await collectStream(streamToFrontend.bind(null, 'openai', 'anthropic'), [
    sse('message_start', JSON.stringify({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 3, output_tokens: 0 } } })),
    sse('content_block_start', JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
    sse('content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } })),
    sse('content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'y' } })),
    sse('message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })),
    sse('message_stop', JSON.stringify({ type: 'message_stop' })),
  ], 'claude-x');
  assert.ok(out.includes('chat.completion.chunk'), '是 chat chunk');
  assert.ok(out.includes('"content":"he"') && out.includes('"content":"y"'), '文本拼接');
  assert.ok(out.includes('[DONE]'), '有 [DONE]');
});

ok('openai 流 -> responses 流（文本）', async () => {
  const out = await collectStream(streamToFrontend.bind(null, 'openai-responses', 'openai'), [
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ], 'gpt-x');
  assert.ok(out.includes('event: response.created'), 'response.created');
  assert.ok(out.includes('response.output_text.delta'), 'output_text.delta');
  assert.ok(out.includes('event: response.completed'), 'response.completed');
  assert.ok(out.includes('"text":"hi"'), '文本');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
