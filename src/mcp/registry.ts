import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ServerInstance {
  projectRoot: string;
  port: number;
  pid: number;
  updatedAt: string;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeRoot(value: string): string {
  return String(value)
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 每个工作区一个实例文件，避免多个窗口同时写同一个 JSON 时互相覆盖。
 * 与 resources/mcp-stdio.js 使用同一目录约定。
 */
export function registryDir(baseDir?: string): string {
  if (baseDir) {
    return baseDir;
  }
  if (process.env.ESMITH_REGISTRY_DIR) {
    return process.env.ESMITH_REGISTRY_DIR;
  }
  return path.join(os.homedir(), '.esmith', 'servers');
}

function hashRoot(root: string): string {
  let hash = 5381;
  const normalized = normalizeRoot(root);
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(index);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function instancePath(projectRoot: string, baseDir?: string): string {
  return path.join(registryDir(baseDir), `${hashRoot(projectRoot)}.json`);
}

export function registerServerInstance(
  projectRoot: string,
  port: number,
  baseDir?: string
): string {
  const dir = registryDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = instancePath(projectRoot, baseDir);
  const instance: ServerInstance = {
    projectRoot,
    port,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(instance, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
  pruneStale(dir);
  return filePath;
}

export function unregisterServerInstance(projectRoot: string, baseDir?: string): void {
  try {
    fs.rmSync(instancePath(projectRoot, baseDir), { force: true });
  } catch {
    // 清理失败不影响扩展退出
  }
}

export function listServerInstances(baseDir?: string): ServerInstance[] {
  const dir = registryDir(baseDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const result: ServerInstance[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, name), 'utf8')
      ) as Partial<ServerInstance>;
      const port = Number(parsed.port);
      if (typeof parsed.projectRoot !== 'string' || !Number.isFinite(port) || port <= 0) {
        continue;
      }
      result.push({
        projectRoot: parsed.projectRoot,
        port,
        pid: Number(parsed.pid) || 0,
        updatedAt: String(parsed.updatedAt ?? ''),
      });
    } catch {
      // 忽略损坏的实例文件
    }
  }
  return result;
}

function pruneStale(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(dir, name);
    try {
      if (now - fs.statSync(filePath).mtimeMs > MAX_AGE_MS) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // 忽略无法访问的文件
    }
  }
}
