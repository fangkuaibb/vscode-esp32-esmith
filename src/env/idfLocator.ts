import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { esmithConfig, idfConfig } from '../config';
import {
  findIdfPy,
  hasMcpSupport,
  IdfInfo,
  isVersionAtLeast,
  normalizePath,
  readIdfVersion,
} from './idfInfo';

const INFO_CACHE = new Map<string, IdfInfo>();

export interface ResolveOptions {
  force?: boolean;
}

interface EimSetup {
  idfPath: string;
  id?: string;
  name?: string;
}

interface IdfCandidate {
  idfPath: string;
  source: string;
}

export function getEspIdfExtension(): vscode.Extension<unknown> | undefined {
  return vscode.extensions.getExtension('espressif.esp-idf-extension');
}

export function isEspIdfExtensionInstalled(): boolean {
  return Boolean(getEspIdfExtension());
}

export async function ensureEspIdfExtensionActivated(): Promise<boolean> {
  const extension = getEspIdfExtension();
  if (!extension) {
    return false;
  }
  if (!extension.isActive) {
    try {
      await extension.activate();
    } catch {
      return false;
    }
  }
  return extension.isActive;
}

function readEimJson(filePath: string): { selected?: string; setups: EimSetup[] } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      idfSelectedId?: string;
      idfInstalled?: Array<{ id?: string; name?: string; path?: string }>;
    };
    const setups = Array.isArray(parsed.idfInstalled)
      ? parsed.idfInstalled
          .filter((item): item is { id?: string; name?: string; path: string } =>
            Boolean(item.path)
          )
          .map((item) => ({
            idfPath: item.path,
            id: item.id,
            name: item.name,
          }))
      : [];
    return { selected: parsed.idfSelectedId, setups };
  } catch {
    return { setups: [] };
  }
}

function listDirectories(basePath: string): string[] {
  try {
    if (!fs.existsSync(basePath)) {
      return [];
    }
    return fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(basePath, entry.name));
  } catch {
    return [];
  }
}

function discoverCandidates(): IdfCandidate[] {
  const candidates: IdfCandidate[] = [];
  const add = (value: string | undefined, source: string) => {
    if (!value) {
      return;
    }
    const normalized = normalizePath(value);
    if (!candidates.some((item) => item.idfPath.toLowerCase() === normalized.toLowerCase())) {
      candidates.push({ idfPath: normalized, source });
    }
  };

  add(esmithConfig().get<string>('idfPath'), 'esmith.idfPath');

  const configuration = idfConfig();
  add(configuration.get<string>('currentSetup'), 'idf.currentSetup');
  add(process.env.IDF_PATH, 'IDF_PATH');

  const home = os.homedir();
  const eimJsonCandidates = [
    configuration.get<string>('eimIdfJsonPath'),
    path.join(home, '.espressif', 'tools', 'eim_idf.json'),
    process.platform === 'win32' ? 'C:\\Espressif\\tools\\eim_idf.json' : '',
    process.platform === 'win32' ? 'E:\\Espressif\\tools\\eim_idf.json' : '',
  ].filter((value): value is string => Boolean(value));

  for (const filePath of eimJsonCandidates) {
    const { selected, setups } = readEimJson(filePath);
    const ordered = [...setups].sort((left, right) => {
      if (left.id === selected) {
        return -1;
      }
      if (right.id === selected) {
        return 1;
      }
      return 0;
    });
    for (const setup of ordered) {
      add(setup.idfPath, 'eim_idf.json');
    }
  }

  const toolsPath = process.env.IDF_TOOLS_PATH;
  if (toolsPath) {
    for (const dir of listDirectories(toolsPath)) {
      add(path.join(dir, 'esp-idf'), 'IDF_TOOLS_PATH');
    }
  }

  for (const dir of listDirectories(path.join(home, '.espressif'))) {
    add(path.join(dir, 'esp-idf'), 'auto');
  }
  for (const dir of listDirectories(path.join(home, '.espressif', 'frameworks'))) {
    add(dir, 'auto');
  }
  if (process.platform === 'win32') {
    for (const dir of listDirectories('C:\\Espressif\\frameworks')) {
      add(dir, 'auto');
    }
  }
  add(path.join(home, 'esp', 'esp-idf'), 'auto');

  const projectConfig = path.join(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    '.espsmith',
    'project.json'
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(projectConfig, 'utf8')) as { idf_path?: string };
    add(parsed.idf_path, '.espsmith/project.json');
    if (parsed.idf_path) {
      const toolsRoot = path.dirname(path.dirname(normalizePath(parsed.idf_path)));
      for (const dir of listDirectories(toolsRoot)) {
        add(path.join(dir, 'esp-idf'), 'auto');
      }
    }
  } catch {
    // ignore
  }

  return candidates;
}

const SOURCE_PRIORITY: Record<string, number> = {
  'esmith.idfPath': 0,
  'idf.currentSetup': 1,
  'eim_idf.json': 2,
  'IDF_PATH': 3,
  'IDF_TOOLS_PATH': 5,
  auto: 6,
  '.espsmith/project.json': 10,
};

function pickCandidate(candidates: IdfCandidate[]): IdfCandidate | undefined {
  const valid = candidates.filter((candidate) => Boolean(findIdfPy(candidate.idfPath)));
  valid.sort((left, right) => {
    const leftPriority = SOURCE_PRIORITY[left.source] ?? 99;
    const rightPriority = SOURCE_PRIORITY[right.source] ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    const leftVersion = readIdfVersion(left.idfPath);
    const rightVersion = readIdfVersion(right.idfPath);
    if (leftVersion === rightVersion) {
      return 0;
    }
    return isVersionAtLeast(leftVersion, rightVersion) ? -1 : 1;
  });
  return valid[0];
}

export async function resolveIdfInfo(options: ResolveOptions = {}): Promise<IdfInfo> {
  const candidate = pickCandidate(discoverCandidates());
  if (!candidate) {
    throw new Error(
      '未找到 ESP-IDF。请先在 ESP-IDF 扩展中选择 IDF 版本，或设置 esmith.idfPath。'
    );
  }
  const idfPath = normalizePath(candidate.idfPath);
  const cacheKey = idfPath.toLowerCase();
  const cached = INFO_CACHE.get(cacheKey);
  if (cached && !options.force) {
    return cached;
  }

  const info: IdfInfo = {
    idfPath,
    version: readIdfVersion(idfPath),
    source: candidate.source,
    hasMcpSupport: hasMcpSupport(idfPath),
  };
  INFO_CACHE.set(cacheKey, info);
  return info;
}

export function clearIdfInfoCache(): void {
  INFO_CACHE.clear();
}
