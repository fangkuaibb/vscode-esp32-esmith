import * as vscode from 'vscode';
import { DoctorCheck } from '../env/doctor';

/**
 * 集成体检结果使用独立输出面板展示，不依赖 Webview。
 * Webview 的 ServiceWorker 在部分环境下会注册失败（尤其是扩展刚更新后），
 * 输出面板可以避免整个体检功能不可用。
 */
export class DoctorPanel {
  private static channel: vscode.OutputChannel | undefined;

  static show(checks: DoctorCheck[]): void {
    if (!DoctorPanel.channel) {
      DoctorPanel.channel = vscode.window.createOutputChannel('ESmith Doctor');
    }
    const channel = DoctorPanel.channel;
    const failed = checks.filter((check) => check.status === 'fail').length;
    const warned = checks.filter((check) => check.status === 'warn').length;
    const summary =
      failed > 0
        ? `发现 ${failed} 个失败项、${warned} 个警告项`
        : warned > 0
          ? `环境可用，有 ${warned} 个警告项`
          : '环境检查全部通过';

    channel.clear();
    channel.appendLine('ESmith 集成体检');
    channel.appendLine(new Date().toLocaleString());
    channel.appendLine(summary);
    channel.appendLine('');

    for (const check of checks) {
      const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✕';
      channel.appendLine(`${icon} ${check.title}`);
      channel.appendLine(`  ${check.message}`);
      if (check.remediation) {
        channel.appendLine(`  修复建议：${check.remediation}`);
      }
      channel.appendLine('');
    }

    channel.show(true);
  }

  static dispose(): void {
    DoctorPanel.channel?.dispose();
    DoctorPanel.channel = undefined;
  }
}
