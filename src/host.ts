import * as vscode from 'vscode';

export type IdeHost = 'vscode' | 'trae' | 'unknown';

/**
 * 根据宿主应用名与 URI scheme 判断当前 IDE。
 * Trae 基于 VS Code，但 appName/uriScheme 会带 trae 标识。
 */
export function detectIdeHost(): IdeHost {
  const appName = String(vscode.env.appName ?? '').toLowerCase();
  const uriScheme = String(vscode.env.uriScheme ?? '').toLowerCase();
  if (appName.includes('trae') || uriScheme.includes('trae')) {
    return 'trae';
  }
  if (
    appName.includes('visual studio code') ||
    uriScheme === 'vscode' ||
    uriScheme === 'vscode-insiders'
  ) {
    return 'vscode';
  }
  return 'unknown';
}

export function ideHostLabel(host: IdeHost): string {
  if (host === 'vscode') {
    return 'VS Code';
  }
  if (host === 'trae') {
    return 'Trae';
  }
  return '当前编辑器';
}
