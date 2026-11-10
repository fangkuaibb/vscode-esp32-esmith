import * as fs from 'fs';
import * as path from 'path';

export interface IdfInfo {
  idfPath: string;
  version: string;
  source: string;
  hasMcpSupport: boolean;
}

export function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value);
    if (!match) {
      return [0, 0, 0];
    }
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

export function findIdfPy(idfPath: string): string | undefined {
  const candidates = [path.join(idfPath, 'tools', 'idf.py'), path.join(idfPath, 'idf.py')];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function readIdfVersion(idfPath: string): string {
  const normalize = (value: string): string => value.trim().replace(/^v/i, '');
  const versionFile = path.join(idfPath, 'version.txt');
  try {
    const raw = fs.readFileSync(versionFile, 'utf8');
    const first = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) {
      return normalize(first);
    }
  } catch {
    // ignore
  }

  // ESP-IDF 源码安装通常没有 version.txt，版本号在 CMake 或头文件中。
  try {
    const cmakeVersion = fs.readFileSync(
      path.join(idfPath, 'tools', 'cmake', 'version.cmake'),
      'utf8'
    );
    const major = /set\(IDF_VERSION_MAJOR\s+(\d+)\)/.exec(cmakeVersion)?.[1];
    const minor = /set\(IDF_VERSION_MINOR\s+(\d+)\)/.exec(cmakeVersion)?.[1];
    const patch = /set\(IDF_VERSION_PATCH\s+(\d+)\)/.exec(cmakeVersion)?.[1];
    if (major && minor && patch) {
      return `${major}.${minor}.${patch}`;
    }
  } catch {
    // ignore
  }

  try {
    const header = fs.readFileSync(
      path.join(idfPath, 'components', 'esp_common', 'include', 'esp_idf_version.h'),
      'utf8'
    );
    const major = /#define\s+ESP_IDF_VERSION_MAJOR\s+(\d+)/.exec(header)?.[1];
    const minor = /#define\s+ESP_IDF_VERSION_MINOR\s+(\d+)/.exec(header)?.[1];
    const patch = /#define\s+ESP_IDF_VERSION_PATCH\s+(\d+)/.exec(header)?.[1];
    if (major && minor && patch) {
      return `${major}.${minor}.${patch}`;
    }
  } catch {
    // ignore
  }

  // EIM 常见目录结构：<tools>/v6.0.1/esp-idf
  const parentName = path.basename(path.dirname(idfPath));
  const parentVersion = /v?(\d+\.\d+(?:\.\d+)?)/.exec(parentName);
  if (parentVersion) {
    return parentVersion[1];
  }

  return 'unknown';
}

export function hasMcpSupport(idfPath: string): boolean {
  return fs.existsSync(path.join(idfPath, 'tools', 'idf_py_actions', 'mcp_ext.py'));
}
