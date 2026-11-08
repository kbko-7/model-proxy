// 协议翻译层：Anthropic Messages <-> OpenAI Chat Completions <-> OpenAI Responses
// 只负责「格式互译」，不做网络/鉴权。被 server.mjs 调用。
// 后端协议只支持两种：anthropic(/v1/messages) 与 openai(/chat/completions)。
// Responses 只作为「前端」协议出现（Codex 用它），总要译成 chat 或 messages 再转发。

let _seq = 0;
function genId(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + (++_seq).toString(36);
}

// ---------- 基础工具 ----------

// 把可读流按行切分（处理跨 chunk 的半行）。
export async function* readLines(readable) {
  let buf = '';
  for await (const chunk of readable) {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
    }
  }
  if (buf) yield buf.replace(/\r$/, '');
}

// 解析 SSE（Anthropic 与 Responses 有 event: 行，OpenAI 只有 data: 行），统一产出 { event, data }。
export async function* parseSSE(readable) {
  let event = 'message';
  let dataLines = [];
  for await (const line of readLines(readable)) {
    if (line === '') {
      if (dataLines.length) yield { event, data: dataLines.join('\n') };
      event = 'message';
      dataLines = [];
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // ':' 开头的注释行忽略
  }
  if (dataLines.length) yield { event, data: dataLines.join('\n') };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- 内容块互译 ----------

// OpenAI content（string | array of {type:text|image_url}）-> Anthropic content
function openaiContentToAnthropic(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const blocks = [];
    for (const part of c) {
      if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
      else if (part.type === 'image_url') {
        const url = part.image_url?.url || '';
        const m = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
    }
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
    return blocks;
  }
  return String(c ?? '');
}

function parseArgs(s) {
  if (s == null) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ---------- 请求翻译 ----------

// Anthropic Messages -> OpenAI Chat Completions
function messagesToChat(b, modelId) {
  const msgs = [];
  if (typeof b.system === 'string' && b.system) msgs.push({ role: 'system', content: b.system });
  else if (Array.isArray(b.system)) {
    const t = b.system.filter((s) => s.type === 'text').map((s) => s.text).join('\n');
    if (t) msgs.push({ role: 'system', content: t });
  }
  for (const m of b.messages || []) {
    if (typeof m.content === 'string') {
      msgs.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    const texts = [];
    const toolCalls = [];
    const toolResults = [];
    const images = [];
    for (const blk of m.content) {
      if (blk.type === 'text') texts.push(blk.text);
      else if (blk.type === 'tool_use') toolCalls.push({ id: blk.id, type: 'function', function: { name: blk.name, arguments: JSON.stringify(blk.input || {}) } });
      else if (blk.type === 'tool_result') toolResults.push(blk);
      else if (blk.type === 'image' && blk.source?.type === 'base64') {
        images.push({ type: 'image_url', image_url: { url: `data:${blk.source.media_type || 'image/png'};base64,${blk.source.data}` } });
      }
    }
    if (toolCalls.length) {
      const contentParts = [...texts.map((t) => ({ type: 'text', text: t })), ...images];
      msgs.push({ role: 'assistant', content: contentParts.length ? contentParts : null, tool_calls: toolCalls });
    } else if (images.length) {
      msgs.push({ role: m.role, content: [...texts.map((t) => ({ type: 'text', text: t })), ...images] });
    } else if (texts.length) {
      msgs.push({ role: m.role, content: texts.join('') });
    }
    // tool_result 单独成一条 tool 消息
    for (const tr of toolResults) {
      msgs.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) });
    }
  }
  const out = { model: modelId, messages: msgs };
  if (b.max_tokens != null) out.max_tokens = b.max_tokens;
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.top_p != null) out.top_p = b.top_p;
  if (Array.isArray(b.stop_sequences) && b.stop_sequences.length) out.stop = b.stop_sequences;
  if (b.stream != null) out.stream = b.stream;
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }));
    if (b.tool_choice) {
      if (b.tool_choice.type === 'auto') out.tool_choice = 'auto';
      else if (b.tool_choice.type === 'any') out.tool_choice = 'required';
      else if (b.tool_choice.type === 'tool' && b.tool_choice.name) out.tool_choice = { type: 'function', function: { name: b.tool_choice.name } };
    }
  }
  return out;
}

// OpenAI Chat Completions -> Anthropic Messages
function chatToMessages(b, modelId) {
  const out = { model: modelId, messages: [] };
  let system = '';
  for (const m of b.messages || []) {
    if (m.role === 'system') {
      const t = openaiContentToAnthropic(m.content);
      if (typeof t === 'string') system += (system ? '\n' : '') + t;
      continue;
    }
    if (m.role === 'user') {
      out.messages.push({ role: 'user', content: openaiContentToAnthropic(m.content) });
    } else if (m.role === 'assistant') {
      const content = [];
      const txt = typeof m.content === 'string' ? m.content : '';
      if (txt) content.push({ type: 'text', text: txt });
      if (m.tool_calls) for (const tc of m.tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: parseArgs(tc.function?.arguments) });
      }
      out.messages.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      out.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] });
    }
  }
  if (system) out.system = system;
  if (b.max_tokens != null) out.max_tokens = b.max_tokens;
  if (b.max_completion_tokens != null) out.max_tokens = b.max_completion_tokens;
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.top_p != null) out.top_p = b.top_p;
  if (b.stop) out.stop_sequences = Array.isArray(b.stop) ? b.stop : [b.stop];
  if (b.stream != null) out.stream = b.stream;
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.filter((t) => t.type === 'function' || t.function).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters || {} }));
    if (b.tool_choice) {
      if (b.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
      else if (b.tool_choice === 'required') out.tool_choice = { type: 'any' };
      else if (b.tool_choice && b.tool_choice.function?.name) out.tool_choice = { type: 'tool', name: b.tool_choice.function.name };
    }
  }
  return out;
}

// Responses 的 input -> 内部消息数组 [{role, content}]（content 为 string）
function responsesInputToMsgs(b) {
  const msgs = [];
  const input = b.input;
  if (typeof input === 'string') { msgs.push({ role: 'user', content: input }); return msgs; }
  for (const it of input || []) {
    const role = it.role || 'user';
    if (typeof it.content === 'string') { msgs.push({ role, content: it.content }); continue; }
    if (Array.isArray(it.content)) {
      const parts = [];
      for (const p of it.content) {
        if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') parts.push(p.text || '');
        else if (p.type === 'input_image') {
          const url = p.image_url || p.file_url || '';
          const m = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (m) parts.push(`[image: ${m[1]}]`); // 文本端无法表达图片，占位（少见于 code 工具）
        }
      }
      msgs.push({ role, content: parts.join('') });
    }
  }
  return msgs;
}

// Responses -> Chat Completions
function responsesToChat(b, modelId) {
  const msgs = [];
  if (b.instructions) msgs.push({ role: 'system', content: b.instructions });
  for (const m of responsesInputToMsgs(b)) msgs.push(m);
  const out = { model: modelId, messages: msgs };
  if (b.max_output_tokens != null) out.max_tokens = b.max_output_tokens;
  if (b.temperature != null) out.temperature = b.temperature;
  if (b.top_p != null) out.top_p = b.top_p;
  if (b.stream != null) out.stream = b.stream;
  if (Array.isArray(b.tools) && b.tools.length) {
    out.tools = b.tools.filter((t) => t.type === 'function').map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || {} } }));
    if (b.tool_choice === 'required') out.tool_choice = 'required';
    else if (b.tool_choice === 'auto') out.tool_choice = 'auto';
  }
  return out;
}

// Responses -> Messages
function responsesToMessages(b, modelId) {
  return chatToMessages(responsesToChat(b, modelId), modelId);
}

// 统一的「前端请求 -> 后端请求」
export function buildBackendRequest(frontendProtocol, backendProtocol, body, modelId) {
  if (frontendProtocol === backendProtocol) return { ...body, model: modelId };
  if (frontendProtocol === 'anthropic' && backendProtocol === 'openai') return messagesToChat(body, modelId);
  if (frontendProtocol === 'openai' && backendProtocol === 'anthropic') return chatToMessages(body, modelId);
  if (frontendProtocol === 'openai-responses' && backendProtocol === 'openai') return responsesToChat(body, modelId);
  if (frontendProtocol === 'openai-responses' && backendProtocol === 'anthropic') return responsesToMessages(body, modelId);
  throw new Error(`不支持的翻译: ${frontendProtocol} -> ${backendProtocol}`);
}

// ---------- 响应翻译（非流式） ----------

// Chat -> Messages
function chatToMessagesResp(c) {
  const choice = (c.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (msg.tool_calls) for (const tc of msg.tool_calls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input: parseArgs(tc.function?.arguments) });
  }
  let stop_reason = 'end_turn';
  if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') stop_reason = 'tool_use';
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens';
  const u = c.usage || {};
  return {
    id: c.id || genId('msg'), type: 'message', role: 'assistant', model: c.model || '',
    content, stop_reason, stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 },
  };
}

// Messages -> Chat
function messagesToChatResp(m) {
  let text = '';
  const toolCalls = [];
  for (const blk of m.content || []) {
    if (blk.type === 'text') text += blk.text;
    else if (blk.type === 'tool_use') toolCalls.push({ id: blk.id, type: 'function', function: { name: blk.name, arguments: JSON.stringify(blk.input || {}) } });
  }
  let finish_reason = 'stop';
  if (m.stop_reason === 'tool_use') finish_reason = 'tool_calls';
  else if (m.stop_reason === 'max_tokens') finish_reason = 'length';
  const u = m.usage || {};
  return {
    id: m.id || genId('chatcmpl'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: m.model || '',
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason }],
    usage: { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) },
  };
}

// Chat -> Responses
function chatToResponsesResp(c) {
  const choice = (c.choices || [])[0] || {};
  const msg = choice.message || {};
  const output = [];
  if (msg.content) output.push({ id: genId('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
  if (msg.tool_calls) for (const tc of msg.tool_calls) {
    output.push({ id: genId('fc'), type: 'function_call', call_id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' });
  }
  const u = c.usage || {};
  return {
    id: c.id || genId('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: c.model || '',
    output,
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) },
  };
}

// Messages -> Responses
function messagesToResponsesResp(m) {
  return chatToResponsesResp(messagesToChatResp(m));
}

export function buildFrontendResponse(frontendProtocol, backendProtocol, backendBody) {
  if (frontendProtocol === backendProtocol) return backendBody;
  if (frontendProtocol === 'anthropic' && backendProtocol === 'openai') return chatToMessagesResp(backendBody);
  if (frontendProtocol === 'openai' && backendProtocol === 'anthropic') return messagesToChatResp(backendBody);
  if (frontendProtocol === 'openai-responses' && backendProtocol === 'openai') return chatToResponsesResp(backendBody);
  if (frontendProtocol === 'openai-responses' && backendProtocol === 'anthropic') return messagesToResponsesResp(backendBody);
  throw new Error(`不支持的翻译: ${backendProtocol} -> ${frontendProtocol}`);
}

// ---------- 流式翻译 ----------

function mapAnthropicStop(r) {
  if (r === 'tool_use') return 'tool_calls';
  if (r === 'max_tokens') return 'length';
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  return 'stop';
}
function mapOpenAIStop(r) {
  if (r === 'tool_calls') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  return 'end_turn';
}

// OpenAI chat 流 -> Anthropic 流
async function openaiStreamToAnthropic(upRes, clientRes, modelId, onUsage) {
  const id = genId('msg');
  const write = (event, data) => clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let started = false;
  let textOpen = false;
  let textIndex = -1;
  let nextIndex = 0;
  const tools = new Map(); // openaiIndex -> {idx, id, name}
  let finishReason = null;
  let inputTokens = 0, outputTokens = 0;

  for await (const { data } of parseSSE(upRes)) {
    if (data === '[DONE]') break;
    const chunk = safeJson(data);
    if (!chunk) continue;
    if (chunk.usage) { inputTokens = chunk.usage.prompt_tokens ?? 0; outputTokens = chunk.usage.completion_tokens ?? 0; }
    const choice = (chunk.choices || [])[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (!started) {
      started = true;
      write('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: modelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    if (delta.content) {
      if (!textOpen) { textOpen = true; textIndex = nextIndex++; write('content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }); }
      write('content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    if (delta.tool_calls) for (const tc of delta.tool_calls) {
      const oi = tc.index ?? 0;
      if (!tools.has(oi)) {
        if (textOpen) { write('content_block_stop', { type: 'content_block_stop', index: textIndex }); textOpen = false; }
        const idx = nextIndex++;
        const t = { idx, id: tc.id || genId('toolu'), name: tc.function?.name || '' };
        tools.set(oi, t);
        write('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } });
      }
      const t = tools.get(oi);
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) write('content_block_delta', { type: 'content_block_delta', index: t.idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (textOpen) write('content_block_stop', { type: 'content_block_stop', index: textIndex });
  for (const t of tools.values()) write('content_block_stop', { type: 'content_block_stop', index: t.idx });
  write('message_delta', { type: 'message_delta', delta: { stop_reason: mapOpenAIStop(finishReason), stop_sequence: null }, usage: { output_tokens: outputTokens } });
  write('message_stop', { type: 'message_stop' });
  if (onUsage) onUsage(inputTokens, outputTokens);
}

// Anthropic 流 -> OpenAI chat 流
async function anthropicStreamToOpenai(upRes, clientRes, modelId, onUsage) {
  const id = genId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const send = (delta, finish, usage) => {
    const obj = { id, object: 'chat.completion.chunk', created, model: modelId, choices: [{ index: 0, delta, finish_reason: finish ?? null }] };
    if (usage) obj.usage = usage;
    clientRes.write('data: ' + JSON.stringify(obj) + '\n\n');
  };
  const tools = new Map(); // anthropic block index -> {oi, id, name, sentName}
  let finishReason = null;
  let usage = null;

  for await (const { data } of parseSSE(upRes)) {
    const obj = safeJson(data);
    if (!obj) continue;
    switch (obj.type) {
      case 'message_start':
        send({ role: 'assistant', content: '' });
        break;
      case 'content_block_start':
        if (obj.content_block?.type === 'tool_use') {
          const oi = tools.size;
          tools.set(obj.index, { oi, id: obj.content_block.id, name: obj.content_block.name || '', sentName: false });
        }
        break;
      case 'content_block_delta':
        if (obj.delta?.type === 'text_delta') send({ content: obj.delta.text });
        else if (obj.delta?.type === 'input_json_delta') {
          const t = tools.get(obj.index);
          if (t) {
            if (!t.sentName) send({ tool_calls: [{ index: t.oi, id: t.id, type: 'function', function: { name: t.name, arguments: obj.delta.partial_json || '' } }] });
            else send({ tool_calls: [{ index: t.oi, function: { arguments: obj.delta.partial_json || '' } }] });
            t.sentName = true;
          }
        }
        break;
      case 'message_delta':
        finishReason = obj.delta?.stop_reason ?? null;
        if (obj.usage) usage = obj.usage;
        break;
      case 'message_stop':
        break;
    }
  }
  const outUsage = usage ? { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0, total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) } : undefined;
  send({}, mapAnthropicStop(finishReason), outUsage);
  clientRes.write('data: [DONE]\n\n');
  if (onUsage) onUsage(usage ? (usage.input_tokens ?? 0) : 0, usage ? (usage.output_tokens ?? 0) : 0);
}

// OpenAI chat 流 -> Responses 流
async function openaiStreamToResponses(upRes, clientRes, modelId, onUsage) {
  const respId = genId('resp');
  const msgId = genId('msg');
  const created = Math.floor(Date.now() / 1000);
  const ev = (name, data) => clientRes.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let phase = 'init';
  let text = '';
  let inputTokens = 0, outputTokens = 0;
  const funcs = new Map(); // openai tool index -> {callId, id, name, args}

  ev('response.created', { type: 'response.created', response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model: modelId, output: [] } });
  ev('response.in_progress', { type: 'response.in_progress', response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model: modelId, output: [] } });

  for await (const { data } of parseSSE(upRes)) {
    if (data === '[DONE]') break;
    const chunk = safeJson(data);
    if (!chunk) continue;
    if (chunk.usage) { inputTokens = chunk.usage.prompt_tokens ?? 0; outputTokens = chunk.usage.completion_tokens ?? 0; }
    const choice = (chunk.choices || [])[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      if (phase === 'init') {
        phase = 'text';
        ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        ev('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      text += delta.content;
      ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: delta.content });
    }
    if (delta.tool_calls) for (const tc of delta.tool_calls) {
      const oi = tc.index ?? 0;
      if (!funcs.has(oi)) {
        const f = { callId: tc.id || genId('call'), id: genId('fc'), name: tc.function?.name || '', args: '' };
        funcs.set(oi, f);
        ev('response.output_item.added', { type: 'response.output_item.added', output_index: funcs.size - 1, item: { id: f.id, type: 'function_call', status: 'in_progress', call_id: f.callId, name: f.name, arguments: '' } });
      }
      const f = funcs.get(oi);
      if (tc.function?.name) f.name = tc.function.name;
      if (tc.function?.arguments) { f.args += tc.function.arguments; ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: f.id, output_index: [...funcs.values()].indexOf(f), delta: tc.function.arguments }); }
    }
  }
  if (phase === 'text') {
    ev('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text });
    ev('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
  }
  let oi = 0;
  for (const f of funcs.values()) {
    ev('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: f.id, output_index: oi, arguments: f.args });
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item: { id: f.id, type: 'function_call', status: 'completed', call_id: f.callId, name: f.name, arguments: f.args } });
    oi++;
  }
  const output = [];
  if (phase === 'text') output.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const f of funcs.values()) output.push({ id: f.id, type: 'function_call', status: 'completed', call_id: f.callId, name: f.name, arguments: f.args });
  ev('response.completed', { type: 'response.completed', response: { id: respId, object: 'response', created_at: created, status: 'completed', model: modelId, output, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } });
  if (onUsage) onUsage(inputTokens, outputTokens);
}

// Anthropic 流 -> Responses 流
async function anthropicStreamToResponses(upRes, clientRes, modelId, onUsage) {
  const respId = genId('resp');
  const msgId = genId('msg');
  const created = Math.floor(Date.now() / 1000);
  const ev = (name, data) => clientRes.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let phase = 'init';
  let text = '';
  let inputTokens = 0, outputTokens = 0;
  const funcs = new Map(); // anthropic block index -> {id, callId, name, args}

  ev('response.created', { type: 'response.created', response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model: modelId, output: [] } });
  ev('response.in_progress', { type: 'response.in_progress', response: { id: respId, object: 'response', created_at: created, status: 'in_progress', model: modelId, output: [] } });

  for await (const { data } of parseSSE(upRes)) {
    const obj = safeJson(data);
    if (!obj) continue;
    switch (obj.type) {
      case 'message_start':
        if (obj.message?.usage) inputTokens = obj.message.usage.input_tokens ?? 0;
        break;
      case 'content_block_start':
        if (obj.content_block?.type === 'tool_use') {
          const f = { id: genId('fc'), callId: obj.content_block.id, name: obj.content_block.name || '', args: '' };
          funcs.set(obj.index, f);
        }
        break;
      case 'content_block_delta':
        if (obj.delta?.type === 'text_delta') {
          if (phase === 'init') {
            phase = 'text';
            ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
            ev('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          }
          text += obj.delta.text;
          ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: obj.delta.text });
        } else if (obj.delta?.type === 'input_json_delta') {
          const f = funcs.get(obj.index);
          if (f) { f.args += obj.delta.partial_json || ''; ev('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: f.id, output_index: [...funcs.values()].indexOf(f), delta: obj.delta.partial_json || '' }); }
        }
        break;
      case 'message_delta':
        if (obj.usage) outputTokens = obj.usage.output_tokens ?? 0;
        break;
    }
  }
  if (phase === 'text') {
    ev('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text });
    ev('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
  }
  const output = [];
  if (phase === 'text') output.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const f of funcs.values()) output.push({ id: f.id, type: 'function_call', status: 'completed', call_id: f.callId, name: f.name, arguments: f.args });
  ev('response.completed', { type: 'response.completed', response: { id: respId, object: 'response', created_at: created, status: 'completed', model: modelId, output, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } });
  if (onUsage) onUsage(inputTokens, outputTokens);
}

// 统一的「后端流 -> 前端流」。frontendProtocol === backendProtocol 时不走这里（由调用方直通）。
// onUsage(i, o)：翻译完成时回报告的输入/输出 token 数（用量统计用，可缺省）。
export async function streamToFrontend(frontendProtocol, backendProtocol, upRes, clientRes, modelId, onUsage) {
  if (frontendProtocol === 'anthropic' && backendProtocol === 'openai') return openaiStreamToAnthropic(upRes, clientRes, modelId, onUsage);
  if (frontendProtocol === 'openai' && backendProtocol === 'anthropic') return anthropicStreamToOpenai(upRes, clientRes, modelId, onUsage);
  if (frontendProtocol === 'openai-responses' && backendProtocol === 'openai') return openaiStreamToResponses(upRes, clientRes, modelId, onUsage);
  if (frontendProtocol === 'openai-responses' && backendProtocol === 'anthropic') return anthropicStreamToResponses(upRes, clientRes, modelId, onUsage);
  throw new Error(`不支持的流式翻译: ${backendProtocol} -> ${frontendProtocol}`);
}
