import * as os from 'os';
import * as path from 'path';
import { esmithConfig, idfConfig } from '../config';
import { fixOpenOcdTapIds, TapIdFixSummary } from './openocdTap';

/**
 * 收集可能包含 openocd-esp32 工具链的根目录。
 * 常见布局：<toolsPath>/openocd-esp32/<version>/openocd-esp32/share/openocd/scripts
 */
export function openOcdSearchRoots(): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined | null) => {
    const text = String(value ?? '').trim();
    if (text) {
      roots.add(text);
    }
  };

  add(process.env.OPENOCD_SCRIPTS);
  add(esmithConfig().get<string>('openocd.scriptsPath'));

  const idf = idfConfig();
  add(idf.get<string>('toolsPath'));
  add(idf.get<string>('toolsPathWin'));

  for (const idfPath of [
    esmithConfig().get<string>('idfPath'),
    idf.get<string>('currentSetup'),
  ]) {
    if (!idfPath) {
      continue;
    }
    let current = path.resolve(idfPath);
    for (let depth = 0; depth < 4; depth += 1) {
      add(current);
      add(path.join(current, 'tools'));
      current = path.dirname(current);
    }
  }

  add(path.join(os.homedir(), '.espressif'));
  add(path.join(os.homedir(), '.espressif', 'tools'));
  if (process.platform === 'win32') {
    add('C:\\Espressif');
    add('D:\\Espressif');
    add('E:\\Espressif');
  }

  return [...roots];
}

export function autoFixOpenOcdTapId(target: string): TapIdFixSummary | undefined {
  if (!target) {
    return undefined;
  }
  const autoFix = esmithConfig().get<boolean>('openocd.autoFixTapId', true);
  return fixOpenOcdTapIds({
    target,
    roots: openOcdSearchRoots(),
    autoFix,
  });
}
