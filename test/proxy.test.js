'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  pathnameOf,
  messagesFromInput,
  parseSseToCompletion,
  jsonToSse,
  looksLikeSse,
  wantsStream,
  buildUpstreamPayload,
  handleRequest,
} = require('../lib/proxy');

function startGateway() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function req(port, method, path, headers = {}, body) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const h = { ...headers };
    if (data != null) h['Content-Type'] = 'application/json';
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers: h },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    if (data != null) r.write(data);
    r.end();
  });
}

test('pathnameOf strips /api prefix and trailing slash', () => {
  assert.equal(pathnameOf({ url: '/api/v1/models' }).pathname, '/v1/models');
  assert.equal(pathnameOf({ url: '/v1/chat/completions/' }).pathname, '/v1/chat/completions');
  assert.equal(pathnameOf({ url: '/api' }).pathname, '/');
});

test('messagesFromInput accepts OpenAI messages and GET prompt', () => {
  const fromBody = messagesFromInput(
    { messages: [{ role: 'user', content: 'hi' }] },
    new URLSearchParams(),
  );
  assert.equal(fromBody[0].content, 'hi');

  const fromQuery = messagesFromInput({}, new URLSearchParams('prompt=Tell+me+a+joke'));
  assert.equal(fromQuery[0].role, 'user');
  assert.equal(fromQuery[0].content, 'Tell me a joke');
});

test('parseSseToCompletion joins streamed deltas', () => {
  const sse = [
    'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n');

  const completion = parseSseToCompletion(sse, 'google/gemini-2.5-pro');
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0].message.content, 'Hello world');
  assert.equal(completion.choices[0].finish_reason, 'stop');
  assert.equal(completion.model, 'google/gemini-2.5-pro');
});

test('jsonToSse emits role, content, stop, and DONE', () => {
  const sse = jsonToSse({
    id: 'chatcmpl-x',
    model: 'google/gemini-2.5-pro',
    created: 1,
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
  });
  assert.match(sse, /data: /);
  assert.match(sse, /Hello|ok/);
  assert.match(sse, /\[DONE\]/);
});

test('looksLikeSse detects event streams', () => {
  assert.equal(looksLikeSse('data: {}\n\n', 'text/plain'), true);
  assert.equal(looksLikeSse('{"id":1}', 'application/json'), false);
  assert.equal(looksLikeSse('{}', 'text/event-stream'), true);
});

test('wantsStream reads body, query, and Accept header', () => {
  assert.equal(wantsStream({ stream: true }, new URLSearchParams(), {}), true);
  assert.equal(wantsStream({}, new URLSearchParams('stream=1'), {}), true);
  assert.equal(
    wantsStream({}, new URLSearchParams(), { accept: 'text/event-stream' }),
    true,
  );
  assert.equal(wantsStream({}, new URLSearchParams(), {}), false);
});

test('buildUpstreamPayload defaults the model', () => {
  const payload = buildUpstreamPayload(
    { messages: [{ role: 'user', content: 'x' }] },
    new URLSearchParams(),
  );
  assert.equal(payload.model, 'google/gemini-2.5-pro');
  assert.equal(payload.messages[0].content, 'x');
});

test('buildUpstreamPayload strips Presenton streaming/tool fields and normalizes messages', () => {
  // Presenton sends a full OpenAI streaming request with array content parts
  // and tools; the upstream must receive clean string messages only.
  const payload = buildUpstreamPayload(
    {
      model: 'google/gemini-2.5-pro',
      stream: true,
      tools: [{ type: 'function', function: { name: 'edit_slide' } }],
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
      n: 2,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'You are an assistant.' }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ],
        },
        { role: 'assistant', content: null, tool_calls: [{ id: 'x', function: { name: 'y' } }] },
      ],
    },
    new URLSearchParams(),
  );
  assert.equal(payload.model, 'google/gemini-2.5-pro');
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['messages', 'model'],
    'only messages + model should be forwarded (no stream flag, no knobs)',
  );
  assert.ok(!('stream' in payload), 'stream must not be forwarded upstream');
  // Normalized to plain strings; the assistant tool_call-only message is dropped.
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'You are an assistant.' },
    { role: 'user', content: 'Hello\n world' },
  ]);
  assert.ok(!('tools' in payload));
  assert.ok(!('tool_choice' in payload));
  assert.ok(!('response_format' in payload));
  assert.ok(!('temperature' in payload));
});

test('gateway does NOT forward Presenton Authorization to the upstream', async () => {
  // A BYOK upstream rejects a present-but-invalid Authorization with 400
  // "Invalid request format", but accepts a request with no auth header (the
  // user's direct GET curl with no key works). So the gateway must call the
  // upstream without Presenton's dummy key.
  let upstreamAuth = 'NOT-SET';
  const upstreamServer = http.createServer((req, res) => {
    upstreamAuth = String(req.headers.authorization || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion',
        model: 'google/gemini-2.5-pro',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }),
    );
  });
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamPort = upstreamServer.address().port;
  process.env.UPSTREAM_URL = `http://127.0.0.1:${upstreamPort}`;

  const server = await startGateway();
  const { port } = server.address();
  try {
    const chat = await req(
      port,
      'POST',
      '/api/v1/chat/completions',
      { Authorization: 'Bearer presenton-dummy-key' },
      { model: 'google/gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    );
    assert.equal(chat.status, 200);
    assert.equal(upstreamAuth, '', 'upstream must NOT receive Presenton Authorization header');
    assert.match(chat.text, /OK/);
  } finally {
    server.close();
    upstreamServer.close();
    delete process.env.UPSTREAM_URL;
  }
});

test('models endpoint stays public even when PROXY_API_KEY is set (presenton check)', async () => {
  process.env.PROXY_API_KEY = 'secret';
  const server = await startGateway();
  const { port } = server.address();
  try {
    // "Check for available models" — presenton may send a key that does not
    // match PROXY_API_KEY. The model list must still be returned.
    const modelsNoAuth = await req(port, 'GET', '/api/v1/models');
    assert.equal(modelsNoAuth.status, 200);
    assert.match(modelsNoAuth.text, /google\/gemini-2\.5-pro/);

    const modelsWrongKey = await req(port, 'GET', '/api/v1/models', {
      Authorization: 'Bearer presenton',
    });
    assert.equal(modelsWrongKey.status, 200);

    // Chat must remain protected when a key is configured.
    const chatNoAuth = await req(port, 'POST', '/api/v1/chat/completions', {}, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(chatNoAuth.status, 401);
  } finally {
    server.close();
    delete process.env.PROXY_API_KEY;
  }
});
