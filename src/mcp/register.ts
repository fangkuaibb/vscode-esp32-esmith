import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJsoncFile } from '../core/jsonc';
import type { IdeHost } from '../host';

export interface McpConfigEntry {
  url: string;
  headers?: Record<string, string>;
}

export interface McpStdioEntry {
  type?: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

function serverCollectionKey(host: IdeHost): 'servers' | 'mcpServers' {
  return host === 'vscode' ? 'servers' : 'mcpServers';
}

export function buildMcpEntry(
  url: string,
  timeoutMs: number,
  host: IdeHost = 'trae'
): Record<string, unknown> {
  const headers = {
    RUN_MCP_TIMEOUT_MS: String(Math.max(1000, timeoutMs)),
  };
  return host === 'vscode'
    ? { type: 'http', url, headers }
    : { url, headers };
}

export function buildStdioEntry(
  extensionPath: string,
  host: IdeHost = 'trae'
): McpStdioEntry {
  const entry: McpStdioEntry = {
    command: 'node',
    args: [path.join(extensionPath, 'resources', 'mcp-stdio.js')],
    env: {
      ESMITH_WORKSPACE: '${workspaceFolder}',
      // 多根工作区下 ${workspaceFolder} 只会展开第一个文件夹，
      // 启动器通过 workspace 文件列出全部 root，再匹配正确的 IDF 工程。
      ESMITH_WORKSPACE_FILE: '${workspaceFile}',
      ESMITH_BASE_PORT: '37821',
    },
  };
  if (host === 'vscode') {
    entry.type = 'stdio';
    // process.cwd() 用于 stdio 启动器兜底推断工作区
    entry.cwd = '${workspaceFolder}';
  }
  return entry;
}

function mergeServerEntry(
  configPath: string,
  host: IdeHost,
  entry: Record<string, unknown>,
  backup: boolean
): { path: string; config: Record<string, unknown> } {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed = readJsoncFile<Record<string, unknown>>(configPath);
    if (parsed && typeof parsed === 'object') {
      existing = parsed;
    }
  }

  const key = serverCollectionKey(host);
  const servers =
    existing[key] && typeof existing[key] === 'object'
      ? (existing[key] as Record<string, unknown>)
      : {};
  servers.esmith = entry;
  existing[key] = servers;

  if (backup) {
    const backupPath = `${configPath}.bak`;
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(configPath, backupPath);
      } catch {
        // 备份失败不影响写入
      }
    }
  }

  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return { path: configPath, config: existing };
}

/**
 * Trae 项目级 HTTP 注册（保留原有行为）。
 */
export function registerProjectMcp(
  workspaceRoot: string,
  url: string,
  timeoutMs: number
): { path: string; config: Record<string, unknown> } {
  return mergeServerEntry(
    path.join(workspaceRoot, '.trae', 'mcp.json'),
    'trae',
    buildMcpEntry(url, timeoutMs, 'trae'),
    false
  );
}

/**
 * VS Code 项目级 stdio 注册。
 * 每个工作区各自一份 .vscode/mcp.json，不依赖固定端口，多窗口天然隔离。
 */
export function registerVscodeProjectMcp(
  workspaceRoot: string,
  extensionPath: string
): { path: string; config: Record<string, unknown> } {
  return mergeServerEntry(
    path.join(workspaceRoot, '.vscode', 'mcp.json'),
    'vscode',
    buildStdioEntry(extensionPath, 'vscode') as unknown as Record<string, unknown>,
    false
  );
}

export function hasProjectMcpEntry(
  workspaceRoot: string,
  host: IdeHost = 'trae'
): boolean {
  const configPath = path.join(
    workspaceRoot,
    host === 'vscode' ? '.vscode' : '.trae',
    'mcp.json'
  );
  const parsed = readJsoncFile<Record<string, Record<string, unknown>>>(
    configPath
  );
  const key = serverCollectionKey(host);
  return Boolean(parsed?.[key]?.esmith);
}

export function mcpConfigSnippet(
  url: string,
  timeoutMs: number,
  host: IdeHost = 'trae'
): string {
  return JSON.stringify(
    {
      [serverCollectionKey(host)]: {
        esmith: buildMcpEntry(url, timeoutMs, host),
      },
    },
    null,
    2
  );
}

export function stdioConfigSnippet(
  extensionPath: string,
  host: IdeHost = 'trae'
): string {
  return JSON.stringify(
    {
      [serverCollectionKey(host)]: {
        esmith: buildStdioEntry(extensionPath, host),
      },
    },
    null,
    2
  );
}

export function globalMcpCandidates(host: IdeHost = 'trae'): string[] {
  const appData = process.env.APPDATA;
  const home = os.homedir();
  const candidates: string[] = [];

  if (host === 'vscode') {
    if (process.platform === 'win32' && appData) {
      candidates.push(path.join(appData, 'Code', 'User', 'mcp.json'));
      candidates.push(path.join(appData, 'Code - Insiders', 'User', 'mcp.json'));
    } else if (process.platform === 'darwin') {
      candidates.push(
        path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
      );
      candidates.push(
        path.join(
          home,
          'Library',
          'Application Support',
          'Code - Insiders',
          'User',
          'mcp.json'
        )
      );
    } else {
      candidates.push(path.join(home, '.config', 'Code', 'User', 'mcp.json'));
      candidates.push(
        path.join(home, '.config', 'Code - Insiders', 'User', 'mcp.json')
      );
    }
    return candidates;
  }

  if (process.platform === 'win32' && appData) {
    candidates.push(path.join(appData, 'Trae CN', 'User', 'mcp.json'));
    candidates.push(path.join(appData, 'Trae', 'User', 'mcp.json'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'mcp.json')
    );
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Trae', 'User', 'mcp.json')
    );
  } else {
    candidates.push(path.join(home, '.config', 'Trae CN', 'User', 'mcp.json'));
    candidates.push(path.join(home, '.config', 'Trae', 'User', 'mcp.json'));
  }
  return candidates;
}

export function globalTraeMcpCandidates(): string[] {
  return globalMcpCandidates('trae');
}

export function registerGlobalMcp(
  extensionPath: string,
  host: IdeHost = 'trae'
): { path: string; config: Record<string, unknown> } | undefined {
  for (const candidate of globalMcpCandidates(host)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    return mergeServerEntry(
      candidate,
      host,
      buildStdioEntry(extensionPath, host) as unknown as Record<string, unknown>,
      true
    );
  }
  return undefined;
}
