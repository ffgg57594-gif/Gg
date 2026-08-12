'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pathnameOf,
  messagesFromInput,
  parseSseToCompletion,
  jsonToSse,
  looksLikeSse,
  wantsStream,
  buildUpstreamPayload,
} = require('../lib/proxy');

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
