import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { McpGateway } from '../src/mcp/server';
import type { EsmithRuntime } from '../src/mcp/runtime';

function stubRuntime(): EsmithRuntime {
  return {
    getProjectRoot: () => process.cwd(),
    getMcpUrl: () => undefined,
  } as unknown as EsmithRuntime;
}

function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'esmith-test', version: '1.0.0' },
    },
  });
}

async function initialize(url: string, id: number): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: initializeBody(id),
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize 必须返回 Mcp-Session-Id');
  const payload = (await response.json()) as {
    jsonrpc?: string;
    result?: { serverInfo?: { name?: string } };
  };
  assert.equal(payload.jsonrpc, '2.0');
  assert.equal(payload.result?.serverInfo?.name, 'esmith');
  return sessionId;
}

test('initialize 可解析 body，且支持多会话', async () => {
  const gateway = new McpGateway(stubRuntime());
  const url = await gateway.start({ host: '127.0.0.1', port: 0 });
  try {
    const first = await initialize(url, 1);
    const second = await initialize(url, 2);
    assert.notEqual(first, second);

    const initialized = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': first,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.ok(initialized.status < 300);

    const list = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': first,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.equal(list.status, 200);
    const payload = (await list.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name);
    assert.ok(names.includes('esmith_project_info'));
    assert.ok(!names.includes('esmith_generate_pins'));
  } finally {
    await gateway.stop();
  }
});

test('未知会话返回 404，重新 initialize 可恢复', async () => {
  const gateway = new McpGateway(stubRuntime());
  const url = await gateway.start({ host: '127.0.0.1', port: 0 });
  try {
    const missing = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-exists',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    assert.equal(missing.status, 404);

    const sessionId = await initialize(url, 10);
    assert.ok(sessionId);
  } finally {
    await gateway.stop();
  }
});
