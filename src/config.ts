import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseJsonc } from './core/jsonc';
import { isEspIdfProject } from './core/project';

const FOLDER_CACHE_MS = 1000;

let cachedFolder: vscode.WorkspaceFolder | undefined;
let cachedAt = 0;
let cacheValid = false;

/**
 * 串口每来一行都会读取配置，文件夹探测做 1 秒缓存，避免频繁读 CMakeLists。
 */
export function invalidateProjectFolderCache(): void {
  cacheValid = false;
}

/**
 * 多根工作区 / workspace 文件场景下，idf.* 与 esmith.* 通常写在工程文件夹的
 * .vscode/settings.json 里。读取配置时必须带上该文件夹的 URI，否则只能读到
 * workspace 级配置（例如只有 idf.currentSetup），flashType / port 会回退默认值。
 */
export function projectFolder(): vscode.WorkspaceFolder | undefined {
  if (cacheValid && Date.now() - cachedAt < FOLDER_CACHE_MS) {
    return cachedFolder;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  cachedFolder =
    folders.find((folder) => isEspIdfProject(folder.uri.fsPath)) ?? folders[0];
  cachedAt = Date.now();
  cacheValid = true;
  return cachedFolder;
}

export function projectScopeUri(): vscode.Uri | undefined {
  return projectFolder()?.uri;
}

export function idfConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('idf', projectScopeUri());
}

export function esmithConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('esmith', projectScopeUri());
}

export interface FreshSetting<T> {
  value: T;
  source: 'folder' | 'workspace';
}

function readSettingsFile(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const parsed = parseJsonc<Record<string, unknown>>(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 直接读取 .vscode/settings.json / .code-workspace 中的值。
 * VS Code 的配置服务在文件被外部修改时可能短暂甚至持续返回旧快照；
 * 这里用于 expectedPattern、flashType、port 等需要立即生效的键。
 */
export function freshSetting<T>(
  section: 'esmith' | 'idf',
  key: string
): FreshSetting<T> | undefined {
  const fullKey = `${section}.${key}`;
  const folder = projectFolder();
  if (folder) {
    const settings = readSettingsFile(
      path.join(folder.uri.fsPath, '.vscode', 'settings.json')
    );
    if (settings && Object.prototype.hasOwnProperty.call(settings, fullKey)) {
      return { value: settings[fullKey] as T, source: 'folder' };
    }
  }

  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile?.scheme === 'file') {
    const parsed = readSettingsFile(workspaceFile.fsPath);
    const settings = parsed?.settings as Record<string, unknown> | undefined;
    if (settings && Object.prototype.hasOwnProperty.call(settings, fullKey)) {
      return { value: settings[fullKey] as T, source: 'workspace' };
    }
  }
  return undefined;
}
