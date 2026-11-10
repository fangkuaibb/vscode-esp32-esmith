import * as vscode from 'vscode';
import { esmithConfig, freshSetting, idfConfig, projectFolder } from '../config';

export interface OpenOcdLaunchOptions {
  /** OpenOCD USB 位置（bus-port），例如 1-3。 */
  location?: string;
  /** adapter speed，单位 kHz。 */
  adapterSpeedKhz?: number;
}

/** 读取 esmith.openocd.adapterSpeed（kHz），无效值返回 undefined。 */
export function adapterSpeedKhz(): number | undefined {
  const raw =
    freshSetting<number | string>('esmith', 'openocd.adapterSpeed')?.value ??
    esmithConfig().get<number | string>('openocd.adapterSpeed');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * 临时把 USB-JTAG 位置 / adapter speed 写入官方扩展的 OpenOCD 启动参数，结束后恢复。
 *
 * 官方扩展在 idf.openOcdLaunchArgs 非空时只使用该列表，不再自动追加
 * idf.openOcdConfigs；因此这里需要把原有 configs 一并带上。
 */
export async function applyOpenOcdLocation(
  options: OpenOcdLaunchOptions | undefined
): Promise<() => Promise<void>> {
  const location = options?.location?.trim();
  const speed = options?.adapterSpeedKhz;
  if (!location && !speed) {
    return async () => undefined;
  }

  const configuration = idfConfig();
  const launchArgs =
    freshSetting<string[]>('idf', 'openOcdLaunchArgs')?.value ??
    configuration.get<string[]>('openOcdLaunchArgs') ??
    [];
  const hasLocation = launchArgs.some((item) =>
    String(item).includes('adapter usb location')
  );
  const hasSpeed = launchArgs.some((item) =>
    String(item).includes('adapter speed')
  );

  const extra: string[] = [];
  if (location && !hasLocation) {
    extra.push(`adapter usb location ${location}`);
  }
  if (speed && !hasSpeed) {
    extra.push(`adapter speed ${speed}`);
  }
  if (extra.length === 0) {
    return async () => undefined;
  }

  let next: string[];
  if (launchArgs.length > 0) {
    next = [...launchArgs, ...extra.flatMap((item) => ['-c', item])];
  } else {
    const configs =
      freshSetting<string[]>('idf', 'openOcdConfigs')?.value ??
      configuration.get<string[]>('openOcdConfigs') ??
      [];
    if (configs.length === 0) {
      return async () => undefined;
    }
    const level = Number(configuration.get<number>('openOcdDebugLevel', 2));
    next = [
      `-d${Number.isFinite(level) && level >= 0 ? Math.floor(level) : 2}`,
      ...configs.flatMap((item) => ['-f', String(item)]),
      ...extra.flatMap((item) => ['-c', item]),
    ];
  }

  const folder = projectFolder();
  const target = folder
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  // 只恢复当前作用域原值，避免把继承来的配置复制成 folder 级覆盖。
  const inspected = configuration.inspect<string[]>('openOcdLaunchArgs');
  const previousAtTarget = folder
    ? inspected?.workspaceFolderValue
    : inspected?.workspaceValue;

  await configuration.update('openOcdLaunchArgs', next, target);
  return async () => {
    await configuration.update('openOcdLaunchArgs', previousAtTarget, target);
  };
}
