import * as fs from 'fs';
import * as path from 'path';

/**
 * OpenOCD 20260304 的 target/esp32c3.cfg 把 _CPUTAPID 误写成 Xtensa 的 0x120034e5，
 * 而 ESP32-C3 实际 IDCODE 是 0x00005c25，导致 TAP 校验失败、OpenOCD 无法启动。
 * 这里按同包 esp-config.json 的正确值修正配置（先备份）。
 */

export interface TapIdFix {
  configPath: string;
  scriptsDir: string;
  previous: string;
  expected: string;
  changed: boolean;
  backupPath?: string;
  error?: string;
}

export interface TapIdFixSummary {
  status: 'ok' | 'fixed' | 'mismatch' | 'not-found';
  fixes: TapIdFix[];
  message: string;
}

export function parseCpuTapId(text: string): string | undefined {
  const setMatch = /set\s+_CPUTAPID\s+(0x[0-9a-fA-F]+)/i.exec(text);
  if (setMatch) {
    return setMatch[1].toLowerCase();
  }
  const expectedMatch = /-expected-id\s+(0x[0-9a-fA-F]+)/i.exec(text);
  return expectedMatch ? expectedMatch[1].toLowerCase() : undefined;
}

export function replaceCpuTapId(
  text: string,
  expected: string
): { text: string; previous: string; changed: boolean } | undefined {
  const pattern = /(set\s+_CPUTAPID\s+)(0x[0-9a-fA-F]+)/i;
  const expectedPattern = /(-expected-id\s+)(0x[0-9a-fA-F]+)/i;
  const match = pattern.exec(text) ?? expectedPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const previous = match[2].toLowerCase();
  if (previous === expected.toLowerCase()) {
    return { text, previous, changed: false };
  }
  const replaced = `${text.slice(0, match.index)}${match[1]}${expected}${text.slice(
    match.index + match[0].length
  )}`;
  return { text: replaced, previous, changed: true };
}

interface EspConfigTarget {
  id?: string;
  idcode?: string;
}

export function expectedTapIdFromEspConfig(
  espConfigText: string,
  target: string
): string | undefined {
  try {
    const parsed = JSON.parse(espConfigText) as { targets?: EspConfigTarget[] };
    const entry = (parsed.targets ?? []).find(
      (item) => String(item.id ?? '').toLowerCase() === target.toLowerCase()
    );
    if (entry?.idcode) {
      return String(entry.idcode).toLowerCase();
    }
  } catch {
    // 非 JSON 时退回正则
  }
  const pattern = new RegExp(
    `"id"\\s*:\\s*"${target}"[\\s\\S]{0,200}?"idcode"\\s*:\\s*"(0x[0-9a-fA-F]+)"`,
    'i'
  );
  const match = pattern.exec(espConfigText);
  return match ? match[1].toLowerCase() : undefined;
}

function existsDir(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(value: string): string[] {
  try {
    return fs.readdirSync(value);
  } catch {
    return [];
  }
}

/**
 * 在给定工具根目录中定位 openocd scripts 目录（可同时命中多个版本）。
 */
export function findOpenOcdScriptsDirs(roots: string[], target: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | undefined) => {
    if (!dir) {
      return;
    }
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) {
      return;
    }
    if (!fs.existsSync(path.join(dir, 'target', `${target}.cfg`))) {
      return;
    }
    seen.add(key);
    found.push(path.resolve(dir));
  };

  const probe = (base: string | undefined) => {
    if (!base) {
      return;
    }
    // 直接指向 scripts、openocd 根目录或安装根目录
    add(base);
    add(path.join(base, 'share', 'openocd', 'scripts'));
    add(path.join(base, 'openocd-esp32', 'share', 'openocd', 'scripts'));
  };

  for (const root of roots) {
    if (!root) {
      continue;
    }
    probe(root);

    for (const toolsRoot of [path.join(root, 'tools'), root]) {
      const openocdRoot = path.join(toolsRoot, 'openocd-esp32');
      if (!existsDir(openocdRoot)) {
        continue;
      }
      for (const version of safeReaddir(openocdRoot)) {
        const versionDir = path.join(openocdRoot, version);
        if (!existsDir(versionDir)) {
          continue;
        }
        probe(versionDir);
        probe(path.join(versionDir, 'openocd-esp32'));
      }
    }
  }
  return found;
}

function readTapId(scriptsDir: string, target: string): string | undefined {
  const espConfigPath = path.join(scriptsDir, 'esp-config.json');
  try {
    const espConfig = fs.readFileSync(espConfigPath, 'utf8');
    const expected = expectedTapIdFromEspConfig(espConfig, target);
    if (expected) {
      return expected;
    }
  } catch {
    // esp-config.json 不可用时只处理已知的 C3
  }
  return target.toLowerCase() === 'esp32c3' ? '0x00005c25' : undefined;
}

export function fixOpenOcdTapIds(options: {
  target: string;
  roots: string[];
  autoFix: boolean;
}): TapIdFixSummary {
  const { target, roots, autoFix } = options;
  const scriptsDirs = findOpenOcdScriptsDirs(roots, target);
  if (scriptsDirs.length === 0) {
    return {
      status: 'not-found',
      fixes: [],
      message: `未找到 OpenOCD 的 target/${target}.cfg；可通过 esmith.openocd.scriptsPath 指定 scripts 目录。`,
    };
  }

  const fixes: TapIdFix[] = [];
  for (const scriptsDir of scriptsDirs) {
    const configPath = path.join(scriptsDir, 'target', `${target}.cfg`);
    const expected = readTapId(scriptsDir, target);
    if (!expected) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      fixes.push({
        configPath,
        scriptsDir,
        previous: '',
        expected,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const patched = replaceCpuTapId(text, expected);
    if (!patched) {
      fixes.push({
        configPath,
        scriptsDir,
        previous: '',
        expected,
        changed: false,
        error: '未找到 _CPUTAPID / -expected-id 配置行',
      });
      continue;
    }
    if (!patched.changed) {
      fixes.push({
        configPath,
        scriptsDir,
        previous: patched.previous,
        expected,
        changed: false,
      });
      continue;
    }
    if (!autoFix) {
      fixes.push({
        configPath,
        scriptsDir,
        previous: patched.previous,
        expected,
        changed: false,
        error: `自动修复已关闭（${patched.previous} != ${expected}）`,
      });
      continue;
    }
    const backupPath = `${configPath}.esmith-bak`;
    try {
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(configPath, backupPath);
      }
      fs.writeFileSync(configPath, patched.text, 'utf8');
      fixes.push({
        configPath,
        scriptsDir,
        previous: patched.previous,
        expected,
        changed: true,
        backupPath,
      });
    } catch (error) {
      fixes.push({
        configPath,
        scriptsDir,
        previous: patched.previous,
        expected,
        changed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fixed = fixes.filter((item) => item.changed);
  const failed = fixes.filter((item) => item.error);

  if (fixed.length > 0) {
    return {
      status: 'fixed',
      fixes,
      message: fixed
        .map(
          (item) =>
            `${item.configPath}：${item.previous} → ${item.expected}${
              item.backupPath ? `（备份 ${item.backupPath}）` : ''
            }`
        )
        .join('；'),
    };
  }
  if (failed.length > 0) {
    return {
      status: 'mismatch',
      fixes,
      message: failed
        .map((item) => `${item.configPath}：${item.error}`)
        .join('；'),
    };
  }
  return {
    status: 'ok',
    fixes,
    message: `OpenOCD ${target} IDCODE 已匹配，无需修改。`,
  };
}
