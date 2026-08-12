'use strict';

const DEFAULT_UPSTREAM =
  'https://qcpujeurnkbvwlvmylyx.supabase.co/functions/v1/chat';
const DEFAULT_MODEL = 'google/gemini-2.5-pro';

function env(name, fallback) {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function getConfig() {
  const models = env('MODELS', env('DEFAULT_MODEL', DEFAULT_MODEL))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    upstream: env('UPSTREAM_URL', DEFAULT_UPSTREAM),
    defaultModel: models[0] || DEFAULT_MODEL,
    models: models.length ? models : [DEFAULT_MODEL],
    apiKey: env('PROXY_API_KEY', ''),
  };
}

function pathnameOf(req) {
  const raw = req.url || '/';
  const url = new URL(raw, 'http://gateway.local');
  let pathname = url.pathname || '/';
  if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
  else if (pathname === '/api') pathname = '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return { pathname: pathname || '/', searchParams: url.searchParams, url };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, OpenAI-Beta, X-Requested-With, Accept',
  );
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (payload && typeof payload === 'object' && 'error' in payload && 'status' in payload) {
    const { status: _ignored, ...body } = payload;
    res.end(JSON.stringify(body));
    return;
  }
  res.end(JSON.stringify(payload));
}

function openaiError(message, type, code, status) {
  return {
    error: {
      message,
      type: type || 'invalid_request_error',
      param: null,
      code: code || null,
    },
    status: status || 400,
  };
}

function isAuthorized(req, searchParams) {
  const { apiKey } = getConfig();
  if (!apiKey) return true;
  const header = String(
    req.headers.authorization || req.headers.Authorization || '',
  );
  const bearer = header.replace(/^Bearer\s+/i, '').trim();
  const queryKey = searchParams.get('api_key') || searchParams.get('key') || '';
  return bearer === apiKey || queryKey === apiKey;
}

function modelsPayload() {
  const { models } = getConfig();
  const created = 1700000000;
  return {
    object: 'list',
    data: models.map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: id.includes('/') ? id.split('/')[0] : 'custom',
    })),
  };
}

function gatewayInfo() {
  const { defaultModel, models } = getConfig();
  return {
    ok: true,
    name: 'Presenton LLM Gateway',
    openai_compatible: true,
    base_url_for_presenton: '/v1',
    model: defaultModel,
    models,
    endpoints: {
      models: 'GET /v1/models',
      chat_post: 'POST /v1/chat/completions',
      chat_get: 'GET /v1/chat/completions?prompt=...',
    },
  };
}

function extractTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          return part.text || part.content || part.output_text || '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    return content.text || content.content || JSON.stringify(content);
  }
  return String(content);
}

function messagesFromInput(body, searchParams) {
  if (body && Array.isArray(body.messages) && body.messages.length) {
    return body.messages;
  }

  const prompt =
    (body && (body.prompt || body.input || body.content || body.q)) ||
    searchParams.get('prompt') ||
    searchParams.get('content') ||
    searchParams.get('q') ||
    searchParams.get('message') ||
    searchParams.get('text') ||
    '';

  if (prompt) {
    return [{ role: 'user', content: String(prompt) }];
  }

  return null;
}

function parseSseToCompletion(sseText, model) {
  let content = '';
  let role = 'assistant';
  let finish = 'stop';
  let id = `chatcmpl-${Date.now()}`;
  let usage = null;
  const toolCalls = [];
  let refusal = null;

  const lines = String(sseText || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    let json;
    try {
      json = JSON.parse(data);
    } catch {
      content += data;
      continue;
    }

    if (json.id) id = json.id;
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;

    const choice = (json.choices && json.choices[0]) || {};
    if (choice.finish_reason) finish = choice.finish_reason;

    const delta = choice.delta || {};
    const message = choice.message || {};

    if (delta.role) role = delta.role;
    if (message.role) role = message.role;
    if (delta.content) content += extractTextFromContent(delta.content);
    if (message.content) content += extractTextFromContent(message.content);
    if (delta.refusal) refusal = delta.refusal;
    if (message.refusal) refusal = message.refusal;

    const incomingTools = delta.tool_calls || message.tool_calls;
    if (Array.isArray(incomingTools)) {
      for (const call of incomingTools) {
        const index = typeof call.index === 'number' ? call.index : toolCalls.length;
        if (!toolCalls[index]) {
          toolCalls[index] = {
            id: call.id || `call_${index}`,
            type: call.type || 'function',
            function: {
              name: (call.function && call.function.name) || '',
              arguments: (call.function && call.function.arguments) || '',
            },
          };
        } else {
          if (call.id) toolCalls[index].id = call.id;
          if (call.function && call.function.name) {
            toolCalls[index].function.name += call.function.name;
          }
          if (call.function && call.function.arguments) {
            toolCalls[index].function.arguments += call.function.arguments;
          }
        }
      }
    }
  }

  const message = { role, content };
  if (refusal) message.refusal = refusal;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || getConfig().defaultModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish || 'stop',
      },
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function jsonToSse(completion) {
  const model = completion.model || getConfig().defaultModel;
  const id = completion.id || `chatcmpl-${Date.now()}`;
  const created = completion.created || Math.floor(Date.now() / 1000);
  const message =
    (completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message) ||
    { role: 'assistant', content: '' };
  const content = extractTextFromContent(message.content);

  const roleChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  const contentChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  const stopChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: completion.usage,
  };

  return (
    `data: ${JSON.stringify(roleChunk)}\n\n` +
    `data: ${JSON.stringify(contentChunk)}\n\n` +
    `data: ${JSON.stringify(stopChunk)}\n\n` +
    'data: [DONE]\n\n'
  );
}

function looksLikeSse(text, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('text/event-stream')) return true;
  const sample = String(text || '').trimStart();
  return sample.startsWith('data:') || sample.includes('\ndata:');
}

function readJsonBody(req) {
  if (req.body != null && req.body !== '') {
    if (Buffer.isBuffer(req.body)) {
      const raw = req.body.toString('utf8');
      if (!raw) return Promise.resolve({});
      try {
        return Promise.resolve(JSON.parse(raw));
      } catch {
        return Promise.resolve({});
      }
    }
    if (typeof req.body === 'string') {
      if (!req.body) return Promise.resolve({});
      try {
        return Promise.resolve(JSON.parse(req.body));
      } catch {
        return Promise.resolve({});
      }
    }
    if (typeof req.body === 'object') {
      return Promise.resolve(req.body);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (typeof req.on !== 'function') {
      finish({});
      return;
    }

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        finish({});
        return;
      }
      try {
        finish(JSON.parse(raw));
      } catch {
        finish({});
      }
    });
    req.on('error', reject);
  });
}

function wantsStream(body, searchParams, headers) {
  if (body && typeof body.stream === 'boolean') return body.stream;
  const query = searchParams.get('stream');
  if (query === '1' || query === 'true') return true;
  if (query === '0' || query === 'false') return false;
  const accept = String((headers && headers.accept) || '').toLowerCase();
  if (accept.includes('text/event-stream')) return true;
  return false;
}

function buildUpstreamPayload(body, searchParams) {
  const { defaultModel } = getConfig();
  const payload = body && typeof body === 'object' ? { ...body } : {};
  const messages = messagesFromInput(payload, searchParams);
  if (messages) payload.messages = messages;
  if (!payload.model) payload.model = defaultModel;
  return payload;
}

async function callUpstream(payload) {
  const { upstream } = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function readAllText(response) {
  return response.text();
}

function writeSseHeaders(res) {
  setCors(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

async function pipeStream(response, res) {
  writeSseHeaders(res);
  if (!response.body) {
    const text = await response.text();
    res.end(text);
    return;
  }

  const reader = response.body.getReader
    ? response.body.getReader()
    : null;

  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
    }
    res.end();
    return;
  }

  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

async function handleChat(req, res, body, searchParams, stream) {
  const payload = buildUpstreamPayload(body, searchParams);
  if (!payload.messages || !payload.messages.length) {
    const err = openaiError(
      'Missing messages. POST JSON { messages } or GET ?prompt=...',
      'invalid_request_error',
      'missing_messages',
      400,
    );
    sendJson(res, err.status, err);
    return;
  }

  let upstream;
  try {
    upstream = await callUpstream(payload);
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    const err = openaiError(
      aborted
        ? 'Upstream chat function timed out'
        : `Could not reach upstream chat function: ${error.message}`,
      'api_error',
      aborted ? 'timeout' : 'upstream_unreachable',
      502,
    );
    sendJson(res, err.status, err);
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';

  if (stream && upstream.ok && contentType.includes('text/event-stream')) {
    await pipeStream(upstream, res);
    return;
  }

  const text = await readAllText(upstream);

  if (!upstream.ok) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.error) {
      sendJson(res, upstream.status, parsed);
      return;
    }
    const err = openaiError(
      text || `Upstream returned HTTP ${upstream.status}`,
      'api_error',
      'upstream_error',
      upstream.status || 502,
    );
    sendJson(res, err.status, err);
    return;
  }

  const sse = looksLikeSse(text, contentType);
  if (stream) {
    writeSseHeaders(res);
    if (sse) {
      res.end(text.endsWith('\n') ? text : `${text}\n`);
      return;
    }
    let completion;
    try {
      completion = JSON.parse(text);
    } catch {
      completion = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
      };
    }
    res.end(jsonToSse(completion));
    return;
  }

  if (sse) {
    sendJson(res, 200, parseSseToCompletion(text, payload.model));
    return;
  }

  try {
    sendJson(res, 200, JSON.parse(text));
  } catch {
    sendJson(res, 200, parseSseToCompletion(text, payload.model));
  }
}

async function handleRequest(req, res) {
  try {
    setCors(res);
    const { pathname, searchParams } = pathnameOf(req);
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === 'HEAD' && (pathname === '/v1' || pathname === '/v1/models')) {
      res.statusCode = 200;
      res.end();
      return;
    }

    const publicPath =
      pathname === '/' ||
      pathname === '/v1' ||
      pathname === '/health' ||
      pathname === '/healthz';

    if (!publicPath && !isAuthorized(req, searchParams)) {
      const err = openaiError(
        'Invalid API key. Set the same value in Presenton as PROXY_API_KEY.',
        'invalid_request_error',
        'invalid_api_key',
        401,
      );
      sendJson(res, 401, err);
      return;
    }

    if (pathname === '/health' || pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/v1') {
      sendJson(res, 200, gatewayInfo());
      return;
    }

    if (pathname === '/v1/models' || pathname === '/models') {
      if (method !== 'GET' && method !== 'POST') {
        sendJson(res, 405, openaiError('Method not allowed', 'invalid_request_error', 'method', 405));
        return;
      }
      sendJson(res, 200, modelsPayload());
      return;
    }

    const isChat =
      pathname === '/v1/chat/completions' ||
      pathname === '/chat/completions' ||
      pathname === '/v1/chat' ||
      pathname === '/chat';

    if (isChat) {
      const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);
      const stream = wantsStream(body, searchParams, req.headers);
      await handleChat(req, res, body, searchParams, stream);
      return;
    }

    if (pathname === '/' ) {
      sendJson(res, 200, gatewayInfo());
      return;
    }

    sendJson(
      res,
      404,
      openaiError(
        `Unknown path ${pathname}. Use GET /v1/models or POST /v1/chat/completions.`,
        'invalid_request_error',
        'not_found',
        404,
      ),
    );
  } catch (error) {
    const err = openaiError(
      error && error.message ? error.message : 'Internal gateway error',
      'api_error',
      'internal',
      500,
    );
    sendJson(res, 500, err);
  }
}

module.exports = {
  DEFAULT_UPSTREAM,
  DEFAULT_MODEL,
  getConfig,
  pathnameOf,
  messagesFromInput,
  parseSseToCompletion,
  jsonToSse,
  looksLikeSse,
  wantsStream,
  buildUpstreamPayload,
  handleRequest,
};
