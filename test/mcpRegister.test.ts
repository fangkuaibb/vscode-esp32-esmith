import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  buildStdioEntry,
  hasProjectMcpEntry,
  registerVscodeProjectMcp,
  stdioConfigSnippet,
} from '../src/mcp/register';

test('VS Code stdio 入口包含 type 与 cwd', () => {
  const entry = buildStdioEntry('E:/ext', 'vscode');
  assert.equal(entry.type, 'stdio');
  assert.equal(entry.cwd, '${workspaceFolder}');
  assert.equal(entry.env?.ESMITH_WORKSPACE, '${workspaceFolder}');
  assert.equal(entry.env?.ESMITH_WORKSPACE_FILE, '${workspaceFile}');
});

test('Trae stdio 入口不写 VS Code 专用字段', () => {
  const entry = buildStdioEntry('E:/ext', 'trae');
  assert.equal(entry.type, undefined);
  assert.equal(entry.cwd, undefined);
});

test('VS Code 配置使用 servers 键', () => {
  const parsed = JSON.parse(stdioConfigSnippet('E:/ext', 'vscode')) as {
    servers?: Record<string, unknown>;
    mcpServers?: Record<string, unknown>;
  };
  assert.ok(parsed.servers?.esmith);
  assert.equal(parsed.mcpServers, undefined);
});

test('写入 .vscode/mcp.json 并保留其它 server', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-vscode-mcp-'));
  const dir = path.join(root, '.vscode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    '{\n  "servers": {\n    "other": { "type": "stdio", "command": "x" }\n  }\n}\n',
    'utf8'
  );

  const result = registerVscodeProjectMcp(root, 'E:/ext');
  const parsed = JSON.parse(fs.readFileSync(result.path, 'utf8')) as {
    servers: Record<string, { type?: string }>;
  };
  assert.ok(parsed.servers.other);
  assert.equal(parsed.servers.esmith.type, 'stdio');
  assert.equal(hasProjectMcpEntry(root, 'vscode'), true);

  fs.rmSync(root, { recursive: true, force: true });
});
