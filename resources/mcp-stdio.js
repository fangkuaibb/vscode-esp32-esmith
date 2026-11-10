#!/usr/bin/env node
/*
 * ESmith MCP stdio 启动器。
 *
 * Trae 为每个窗口启动一个独立的 stdio 进程。本进程根据窗口工作区找到对应的
 * ESMith HTTP MCP Server，并把 stdio 的 JSON-RPC 消息代理到该 Server。
 * 这样多个 Trae 窗口可以打开不同项目，各自连接自己的 ESMith 实例。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const BASE_PORT = Number(process.env.ESMITH_BASE_PORT || 37821);
const PORT_RANGE = 200;
const TIMEOUT_MS = Number(process.env.RUN_MCP_TIMEOUT_MS || 600000);
const START_TIMEOUT_MS = Number(process.env.ESMITH_START_TIMEOUT_MS || 30000);
const EXPLICIT_PORT = Number(process.env.ESMITH_PORT || 0);

let sessionId;
let serverPort;
let workspaces;
let lastRegistryMissSignature = '';

function log(message) {
  process.stderr.write(`[esmith-stdio] ${message}\n`);
}

function normalizePath(value) {
  if (!value) {
    return '';
  }
  return String(value)
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function stripJsonc(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * 多根工作区下 ${workspaceFolder} 只展开第一个文件夹。读取 .code-workspace，
 * 把全部 root 都加入候选，才能匹配到排在后位的 ESP-IDF 工程。
 */
function addWorkspaceFileRoots(add) {
  const raw = process.env.ESMITH_WORKSPACE_FILE;
  if (
    !raw ||
    raw.includes('${') ||
    !/\.code-workspace$/i.test(raw) ||
    !fs.existsSync(raw)
  ) {
    return;
  }
  try {
    const data = JSON.parse(stripJsonc(fs.readFileSync(raw, 'utf8')));
    const base = path.dirname(raw);
    for (const folder of Array.isArray(data.folders) ? data.folders : []) {
      if (folder && typeof folder.path === 'string') {
        add(path.resolve(base, folder.path));
      } else if (folder && typeof folder.uri === 'string') {
        add(folder.uri.replace(/^file:\/\//i, ''));
      }
    }
  } catch (error) {
    log(`工作区文件解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 收集候选工作区路径。Trae 若没有替换 ${workspaceFolder}，则回退到
 * 进程工作目录；两者都参与匹配，避免配置变量未展开时连错窗口。
 */
function pickWorkspaces() {
  const result = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || value.includes('${')) {
      return;
    }
    const resolved = path.resolve(value);
    const key = normalizePath(resolved);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(resolved);
  };
  for (const key of [
    'ESMITH_WORKSPACE',
    'TRAE_WORKSPACE',
    'VSCODE_WORKSPACE',
    'INIT_CWD',
  ]) {
    add(process.env[key]);
  }
  addWorkspaceFileRoots(add);
  // 只有拿不到任何工作区信息时才回退到进程工作目录，
  // 避免 Trae 把 cwd 设为用户目录或其它工程时串台。
  if (result.length === 0) {
    add(process.cwd());
  }
  return result;
}

function registryDir() {
  if (process.env.ESMITH_REGISTRY_DIR) {
    return process.env.ESMITH_REGISTRY_DIR;
  }
  return path.join(os.homedir(), '.esmith', 'servers');
}

/**
 * 扩展启动 MCP Server 时会为每个工程写一个实例文件，记录 projectRoot + port。
 * 这比扫描 200 个端口更直接，也能覆盖 ${workspaceFolder} 指向非 IDF 文件夹的情况。
 */
function readRegistryInstances() {
  let names;
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  const seenPorts = new Set();
  const result = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(path.join(registryDir(), name), 'utf8'));
      const port = Number(data && data.port);
      if (
        !data ||
        typeof data.projectRoot !== 'string' ||
        !Number.isFinite(port) ||
        port <= 0 ||
        seenPorts.has(port)
      ) {
        continue;
      }
      seenPorts.add(port);
      result.push({ projectRoot: data.projectRoot, port });
    } catch {
      // 忽略损坏的实例文件
    }
  }
  return result;
}

async function discoverFromRegistry(roots) {
  const entries = readRegistryInstances();
  if (entries.length === 0) {
    return undefined;
  }
  const healths = await Promise.all(entries.map((entry) => getHealth(entry.port)));
  const healthy = [];
  const partialMatches = [];
  for (let index = 0; index < entries.length; index += 1) {
    const health = healths[index];
    if (!health || health.name !== 'esmith') {
      continue;
    }
    healthy.push({ port: entries[index].port, health });
    const score = bestScore(health, roots);
    if (score === 2) {
      return { port: entries[index].port, health, score };
    }
    if (score === 1) {
      partialMatches.push({ port: entries[index].port, health, score });
    }
  }
  // 前缀匹配必须唯一；否则宁可失败，也不能绑到别的工程。
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  const candidates = partialMatches.length > 0 ? partialMatches : healthy;
  if (candidates.length > 0) {
    const candidateText = candidates
      .map((item) => `${item.health.projectRoot}@${item.port}`)
      .join(', ');
    const signature = `${candidateText}|${roots.join('|')}|${
      partialMatches.length > 1 ? 'ambiguous' : 'miss'
    }`;
    if (signature !== lastRegistryMissSignature) {
      lastRegistryMissSignature = signature;
      log(
        `${partialMatches.length > 1 ? '多个前缀匹配实例，拒绝自动选择' : 'registry 中的实例都不匹配当前工作区，继续等待'}：` +
          `${candidateText}；工作区=${roots.join(' | ')}`
      );
    }
  }
  return undefined;
}

function preferredPort(root) {
  let hash = 5381;
  const normalized = normalizePath(root);
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(index);
    hash >>>= 0;
  }
  return BASE_PORT + (hash % PORT_RANGE);
}

function getHealth(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        timeout: 800,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(undefined);
    });
    request.on('error', () => resolve(undefined));
  });
}

/**
 * 2 = 完全一致；1 = 互为父子目录；0 = 不匹配。
 */
function matchScore(health, root) {
  if (!health || health.name !== 'esmith') {
    return 0;
  }
  const expected = normalizePath(root);
  const actual = normalizePath(health.projectRoot);
  if (!expected || !actual) {
    return 0;
  }
  if (expected === actual) {
    return 2;
  }
  if (expected.startsWith(`${actual}/`) || actual.startsWith(`${expected}/`)) {
    return 1;
  }
  return 0;
}

function bestScore(health, roots) {
  let best = 0;
  for (const root of roots) {
    const score = matchScore(health, root);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

async function scanPorts(roots) {
  const ports = [];
  for (let offset = 0; offset < PORT_RANGE; offset += 1) {
    ports.push(BASE_PORT + offset);
  }
  let partial;
  const concurrency = 32;
  for (let index = 0; index < ports.length; index += concurrency) {
    const batch = ports.slice(index, index + concurrency);
    const healths = await Promise.all(batch.map((port) => getHealth(port)));
    for (let offset = 0; offset < healths.length; offset += 1) {
      const health = healths[offset];
      if (!health || health.name !== 'esmith') {
        continue;
      }
      const score = bestScore(health, roots);
      if (score === 2) {
        return { port: batch[offset], health, score };
      }
      if (score === 1 && !partial) {
        partial = { port: batch[offset], health, score };
      }
    }
  }
  return partial;
}

async function discoverServer() {
  if (serverPort) {
    const health = await getHealth(serverPort);
    if (health && health.name === 'esmith') {
      return serverPort;
    }
    serverPort = undefined;
  }

  const deadline = Date.now() + START_TIMEOUT_MS;

  // 项目 .trae/mcp.json 可写入固定端口，优先直连，避免任何猜测。
  if (EXPLICIT_PORT > 0) {
    while (Date.now() < deadline) {
      const health = await getHealth(EXPLICIT_PORT);
      if (health && health.name === 'esmith') {
        serverPort = EXPLICIT_PORT;
        log(`使用指定端口 ${EXPLICIT_PORT}`);
        return serverPort;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const expectedPorts = workspaces.length
    ? [...new Set(workspaces.map((root) => preferredPort(root)))]
    : [BASE_PORT];
  const graceDeadline = Date.now() + Math.min(10000, START_TIMEOUT_MS);

  while (Date.now() < deadline) {
    // 1) 先等本窗口工程的期望端口。扩展可能在本进程启动之后才完成监听与登记，
    //    这段时间内绝不能回退到其它工程的实例。
    for (const port of expectedPorts) {
      const health = await getHealth(port);
      if (health && health.name === 'esmith' && bestScore(health, workspaces) === 2) {
        serverPort = port;
        log(`${health.projectRoot} -> port ${port}（期望端口）`);
        return serverPort;
      }
    }

    // 2) 注册表只接受 projectRoot 与当前工作区匹配的实例。
    const registered = await discoverFromRegistry(workspaces);
    if (registered) {
      serverPort = registered.port;
      log(
        `registry: ${registered.health.projectRoot} -> port ${registered.port}` +
          (registered.score === 2 ? '' : '（目录前缀匹配）')
      );
      return serverPort;
    }

    // 3) 启动初期不做全端口扫描，避免在实例尚未登记时误选其它工程。
    if (Date.now() >= graceDeadline) {
      const scanned = await scanPorts(workspaces);
      if (scanned) {
        serverPort = scanned.port;
        log(
          `${scanned.health.projectRoot} -> port ${scanned.port}` +
            (scanned.score === 2 ? '' : '（目录前缀匹配）')
        );
        return serverPort;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  log(
    `等待超时：workspace=${workspaces.join(' | ') || '(空)'} expectedPorts=${expectedPorts.join(
      ','
    )}`
  );
  return undefined;
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function post(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
      RUN_MCP_TIMEOUT_MS: String(TIMEOUT_MS),
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const request = http.request(
      {
        host: '127.0.0.1',
        port: serverPort,
        path: '/mcp',
        method: 'POST',
        headers,
      },
      (response) => {
        const header = response.headers['mcp-session-id'];
        if (header) {
          sessionId = Array.isArray(header) ? header[0] : header;
        }
        const contentType = String(response.headers['content-type'] || '');
        if (contentType.includes('text/event-stream')) {
          let buffer = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data:')) {
                continue;
              }
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') {
                continue;
              }
              try {
                writeMessage(JSON.parse(data));
              } catch {
                // 忽略无法解析的事件
              }
            }
          });
          response.on('end', resolve);
          return;
        }

        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          if (text.trim()) {
            try {
              writeMessage(JSON.parse(text));
            } catch {
              // 忽略空响应或非 JSON 响应
            }
          }
          resolve();
        });
      }
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function handleMessage(message) {
  const port = await discoverServer();
  if (!port) {
    if (message && message.id !== undefined) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `ESmith MCP Server 未找到。工作区: ${workspaces.join(', ')}`,
        },
      });
    } else {
      log(`未找到 ESmith MCP Server，工作区: ${workspaces.join(', ')}`);
    }
    return;
  }

  try {
    await post(message);
  } catch (error) {
    serverPort = undefined;
    if (message && message.id !== undefined) {
      writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `ESmith MCP 请求失败: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }
}

function main() {
  workspaces = pickWorkspaces();
  log(
    `workspace=${workspaces.join(' | ')} expectedPort=${
      workspaces.length > 0 ? preferredPort(workspaces[0]) : BASE_PORT
    }`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let queue = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      log(`无法解析 stdin JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    queue = queue.then(() => handleMessage(message)).catch((error) => {
      log(`处理消息失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main();
