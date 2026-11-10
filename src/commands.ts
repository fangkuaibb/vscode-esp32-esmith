import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { installAgentRules } from './agent/rules';
import { esmithConfig, invalidateProjectFolderCache } from './config';
import { cleanupOpenOcd, DEFAULT_OPENOCD_PORT, shutdownOpenOcd } from './core/openocd';
import { isEspIdfProject, detectTarget } from './core/project';
import {
  initializeProject as initializeIdfProject,
  sanitizeProjectName,
  targetDisplayName,
} from './core/projectInitializer';
import { detectIdeHost, ideHostLabel } from './host';
import {
  mcpConfigSnippet,
  registerGlobalMcp,
  registerProjectMcp,
  registerVscodeProjectMcp,
  stdioConfigSnippet,
} from './mcp/register';
import { EsmithRuntimeImpl } from './runtime';
import { DoctorPanel } from './ui/doctorPanel';

const COMMON_TARGETS = [
  'esp32',
  'esp32s2',
  'esp32s3',
  'esp32c2',
  'esp32c3',
  'esp32c6',
  'esp32h2',
  'esp32p4',
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function showFailure(message: string, runtime: EsmithRuntimeImpl): Promise<void> {
  const action = await vscode.window.showErrorMessage(message, '显示输出');
  if (action === '显示输出') {
    runtime.output.show();
  }
}

interface AgentIntegrationResult {
  hostLabel: string;
  mcpPaths: string[];
  rulesPath?: string;
  errors: string[];
}

/**
 * 一键接入 AI：按宿主写入 MCP 配置并生成 Agent 规则。
 * initialize / 树视图 / 命令面板都走这一条路径，避免用户重复点击。
 */
function setupAgentIntegration(
  context: vscode.ExtensionContext,
  runtime: EsmithRuntimeImpl,
  projectRoot: string
): AgentIntegrationResult {
  const host = detectIdeHost();
  const hostLabel = ideHostLabel(host);
  const configuration = esmithConfig();
  const mcpPaths: string[] = [];
  const errors: string[] = [];

  if (configuration.get<boolean>('mcp.enabled', true)) {
    try {
      if (host === 'vscode') {
        mcpPaths.push(
          registerVscodeProjectMcp(projectRoot, context.extensionPath).path
        );
      } else {
        const url = runtime.getMcpUrl();
        if (url) {
          const timeoutMs = configuration.get<number>('mcp.timeoutMs', 600000);
          mcpPaths.push(registerProjectMcp(projectRoot, url, timeoutMs).path);
        }
        const global = registerGlobalMcp(context.extensionPath, host);
        if (global) {
          mcpPaths.push(global.path);
        }
      }
    } catch (error) {
      errors.push(`MCP：${errorMessage(error)}`);
    }
  }

  let rulesPath: string | undefined;
  try {
    rulesPath = installAgentRules(projectRoot, host);
  } catch (error) {
    errors.push(`Agent 规则：${errorMessage(error)}`);
  }

  for (const item of mcpPaths) {
    runtime.output.appendLine(`[ai] MCP 配置：${item}`);
  }
  if (rulesPath) {
    runtime.output.appendLine(`[ai] Agent 规则：${rulesPath}`);
  }
  for (const item of errors) {
    runtime.output.appendLine(`[ai] ${item}`);
  }

  return { hostLabel, mcpPaths, rulesPath, errors };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  runtime: EsmithRuntimeImpl
): vscode.Disposable[] {
  const register = (command: string, callback: (...args: any[]) => any) =>
    vscode.commands.registerCommand(command, callback);

  return [
    register('esmith.doctor', async () => {
      try {
        const checks = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'ESmith 集成体检',
            cancellable: false,
          },
          () => runtime.doctor()
        );
        DoctorPanel.show(checks);
        const failures = checks.filter((check) => check.status === 'fail').length;
        if (failures > 0) {
          void vscode.window.showWarningMessage(`ESmith 体检发现 ${failures} 个失败项。`);
        } else {
          void vscode.window.showInformationMessage('ESmith 集成体检通过。');
        }
      } catch (error) {
        await showFailure(`集成体检失败：${errorMessage(error)}`, runtime);
      }
    }),

    register('esmith.initProject', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        void vscode.window.showErrorMessage('请先打开一个文件夹，再初始化 ESP-IDF 工程。');
        return;
      }

      let folder = folders[0];
      if (folders.length > 1) {
        const picked = await vscode.window.showQuickPick(
          folders.map((item) => ({
            label: item.name,
            description: item.uri.fsPath,
            folder: item,
          })),
          { title: '选择要初始化的文件夹' }
        );
        if (!picked) {
          return;
        }
        folder = picked.folder;
      }
      const root = folder.uri.fsPath;

      if (isEspIdfProject(root)) {
        void vscode.window.showInformationMessage(
          '当前文件夹已经是 ESP-IDF 工程，无需初始化。'
        );
        return;
      }

      const environment = runtime.getIdfInfo() ?? (await runtime.refreshIdfInfo(true));
      if (!environment) {
        void vscode.window.showErrorMessage(
          '未找到 ESP-IDF。请先运行 ESMith: 集成体检，并确认官方 ESP-IDF 扩展已完成环境初始化。'
        );
        return;
      }

      const hasCmake = fs.existsSync(path.join(root, 'CMakeLists.txt'));
      const meaningfulEntries = fs
        .readdirSync(root)
        .filter((name) => !['.git', '.vscode', '.trae', '.espsmith'].includes(name));
      if (hasCmake) {
        const confirmed = await vscode.window.showWarningMessage(
          '当前目录已有 CMakeLists.txt，但不是标准 ESP-IDF 工程。ESmith 只会添加缺失文件，不会覆盖已有文件。继续？',
          { modal: true },
          '继续'
        );
        if (confirmed !== '继续') {
          return;
        }
      } else if (meaningfulEntries.length > 0) {
        const confirmed = await vscode.window.showWarningMessage(
          '当前目录已有文件。ESmith 将添加缺失的 ESP-IDF 工程文件，不会覆盖已有文件。继续？',
          { modal: true },
          '继续'
        );
        if (confirmed !== '继续') {
          return;
        }
      }

      const templatePick = await vscode.window.showQuickPick<
        { label: string; description: string; value: 'blank' | 'blink' }
      >(
        [
          {
            label: 'Blank（Hello World）',
            description: '最小工程，串口打印 Hello from <工程名>!',
            value: 'blank',
          },
          {
            label: 'Blink（GPIO2）',
            description: '每 500ms 翻转 GPIO2，适合快速验证开发板',
            value: 'blink',
          },
        ],
        { title: '选择工程模板' }
      );
      if (!templatePick) {
        return;
      }

      const detectedTarget = detectTarget(root);
      const targetPick = await vscode.window.showQuickPick(
        COMMON_TARGETS.map((target) => ({
          label: target,
          description: target === detectedTarget ? '当前检测' : undefined,
        })),
        { title: '选择目标芯片', placeHolder: '默认 esp32' }
      );
      if (!targetPick) {
        return;
      }

      const projectName = await vscode.window.showInputBox({
        title: '工程名称',
        prompt: '用于 CMake project() 和生成的 main.c',
        value: sanitizeProjectName(path.basename(root)),
        validateInput: (value) =>
          sanitizeProjectName(value) === 'app' && !value.trim()
            ? '工程名称不能为空'
            : undefined,
      });
      if (!projectName) {
        return;
      }

      const flashPick = await vscode.window.showQuickPick<
        { label: string; value: string | undefined }
      >(
        [
          { label: '不指定', value: undefined },
          { label: '2MB', value: '2MB' },
          { label: '4MB', value: '4MB' },
          { label: '8MB', value: '8MB' },
          { label: '16MB', value: '16MB' },
        ],
        { title: 'Flash 大小（可选）' }
      );
      if (!flashPick) {
        return;
      }

      try {
        const result = await runtime.initializeProject({
          projectRoot: root,
          target: targetPick.label,
          template: templatePick.value,
          projectName,
          flashSize: flashPick.value,
        });
        invalidateProjectFolderCache();
        await runtime.refreshIdfInfo(true);
        runtime.refreshProjectState();

        // 初始化完成后顺手接入 AI，避免用户再去点“注册 MCP”和“生成 Agent 规则”。
        const integration = setupAgentIntegration(context, runtime, root);
        const aiNote =
          integration.errors.length === 0
            ? '，已接入 AI（MCP + Agent 规则）'
            : `，AI 集成部分失败（${integration.errors.join('；')}），详见输出`;

        const action = await vscode.window.showInformationMessage(
          `已初始化 ESP-IDF 工程 ${result.projectName}（${targetDisplayName(
            result.target
          )}，${templatePick.label}）${aiNote}。接下来请在官方 ESP-IDF 扩展中编译/烧录，或使用 ESMith 一键闭环。`,
          '打开 main.c',
          '显示输出'
        );
        if (action === '打开 main.c') {
          const document = await vscode.workspace.openTextDocument(
            path.join(root, 'main', 'main.c')
          );
          await vscode.window.showTextDocument(document);
        } else if (action === '显示输出') {
          runtime.output.show();
        }
      } catch (error) {
        await showFailure(`初始化工程失败：${errorMessage(error)}`, runtime);
      }
    }),

    register('esmith.closedLoop', async () => {
      const port = runtime.currentPortLabel();
      if (!port) {
        void vscode.window.showWarningMessage(
          '请先在官方 ESP-IDF 扩展中选择串口（ESP-IDF: Select Port to Use），或在 MCP 调用中传入 port。'
        );
        return;
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'ESmith 一键闭环',
            cancellable: true,
          },
          async (progress, token) => {
            const cancellation = token.onCancellationRequested(() => runtime.stop());
            progress.report({ message: '官方扩展编译 → 官方扩展烧录 → 串口验证' });
            try {
              const result = await runtime.closedLoop({ port });
              runtime.output.appendLine(JSON.stringify(result, null, 2));
              if (result.success) {
                void vscode.window
                  .showInformationMessage(
                    `闭环通过：${result.target ?? 'unknown'} · ${result.durationMs}ms`,
                    '打开 ESP-IDF 监视器',
                    '显示输出'
                  )
                  .then(async (action) => {
                    if (action === '打开 ESP-IDF 监视器') {
                      await runtime.openMonitor();
                    } else if (action === '显示输出') {
                      runtime.output.show();
                    }
                  });
              } else if (result.cancelled) {
                void vscode.window.showWarningMessage('闭环已取消。');
              } else {
                const crash = result.serial?.crash?.signature
                  ? `，崩溃：${result.serial.crash.signature}`
                  : '';
                await showFailure(
                  `闭环失败：${result.message}${crash}`,
                  runtime
                );
              }
            } finally {
              cancellation.dispose();
            }
          }
        );
      } catch (error) {
        await showFailure(`闭环失败：${errorMessage(error)}`, runtime);
      }
    }),

    register('esmith.stop', async () => {
      runtime.stop();
      void vscode.window.showInformationMessage('已请求停止当前任务。');
    }),

    register('esmith.cleanupOpenOcd', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        `这会结束占用 ${DEFAULT_OPENOCD_PORT} 端口的 OpenOCD 进程，可能影响另一个窗口正在进行的调试。确认继续？`,
        { modal: true },
        '继续'
      );
      if (confirmed !== '继续') {
        return;
      }
      try {
        // 先尝试 TCL shutdown（优雅退出），失败再强制结束。
        const graceful = await shutdownOpenOcd();
        if (graceful) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          const after = await cleanupOpenOcd(DEFAULT_OPENOCD_PORT);
          if (!after.cleaned && after.reason === 'port-not-listening') {
            void vscode.window.showInformationMessage('已优雅停止 OpenOCD。');
            return;
          }
        }
        const result = await cleanupOpenOcd(DEFAULT_OPENOCD_PORT);
        if (result.cleaned) {
          void vscode.window.showInformationMessage(
            `已结束残留 OpenOCD（PID ${result.pid}）。`
          );
        } else if (result.reason === 'not-openocd') {
          void vscode.window.showWarningMessage(
            `端口 ${DEFAULT_OPENOCD_PORT} 被非 OpenOCD 进程占用（PID ${result.pid}），未处理。`
          );
        } else {
          void vscode.window.showInformationMessage(
            `端口 ${DEFAULT_OPENOCD_PORT} 没有监听进程。`
          );
        }
      } catch (error) {
        await showFailure(`清理 OpenOCD 失败：${errorMessage(error)}`, runtime);
      }
    }),

    register('esmith.showOutput', () => {
      runtime.output.show();
    }),

    register('esmith.refresh', async () => {
      await runtime.refreshIdfInfo(true);
      const environment = runtime.getIdfInfo();
      if (environment) {
        void vscode.window.showInformationMessage(
          `ESmith 已刷新：IDF ${environment.version}`
        );
      } else {
        void vscode.window.showWarningMessage('ESmith 未能定位 ESP-IDF。');
      }
    }),

    register('esmith.registerMcp', async () => {
      const host = detectIdeHost();
      const hostLabel = ideHostLabel(host);
      const url = runtime.getMcpUrl();
      const timeoutMs = esmithConfig().get<number>('mcp.timeoutMs', 600000);
      const workspaceRoot = runtime.getProjectRoot();

      if (host === 'vscode') {
        const picked = await vscode.window.showQuickPick(
          [
            {
              label: '写入项目 .vscode/mcp.json（stdio，推荐）',
              value: 'project',
              description: '每个工作区独立，多窗口互不影响',
            },
            {
              label: '写入用户级 VS Code mcp.json（stdio）',
              value: 'global',
              description: '项目未配置时使用，依赖 ${workspaceFolder}',
            },
            {
              label: '复制项目 stdio 配置',
              value: 'copyProject',
              description: '手动粘贴到 .vscode/mcp.json',
            },
            {
              label: '复制用户级 stdio 配置',
              value: 'copyGlobal',
              description: '手动粘贴到 VS Code 用户 mcp.json',
            },
          ],
          { title: `注册 ESmith MCP（${hostLabel}）`, placeHolder: '选择注册方式' }
        );
        if (!picked) {
          return;
        }

        if (picked.value === 'copyProject' || picked.value === 'copyGlobal') {
          await vscode.env.clipboard.writeText(
            stdioConfigSnippet(context.extensionPath, 'vscode')
          );
          void vscode.window.showInformationMessage('stdio 配置已复制到剪贴板。');
          return;
        }

        if (picked.value === 'project') {
          if (!workspaceRoot) {
            void vscode.window.showErrorMessage('当前没有打开工作区。');
            return;
          }
          const result = registerVscodeProjectMcp(
            workspaceRoot,
            context.extensionPath
          );
          const action = await vscode.window.showInformationMessage(
            `已写入 ${result.path}。Reload Window 后 ESmith MCP 工具会出现在 VS Code 中。`,
            '打开文件',
            '复制配置'
          );
          if (action === '打开文件') {
            const document = await vscode.workspace.openTextDocument(result.path);
            await vscode.window.showTextDocument(document);
          } else if (action === '复制配置') {
            await vscode.env.clipboard.writeText(
              stdioConfigSnippet(context.extensionPath, 'vscode')
            );
          }
          return;
        }

        const result = registerGlobalMcp(context.extensionPath, 'vscode');
        if (result) {
          void vscode.window.showInformationMessage(
            `已写入 ${result.path}。Reload Window 后生效。`
          );
        } else {
          await vscode.env.clipboard.writeText(
            stdioConfigSnippet(context.extensionPath, 'vscode')
          );
          void vscode.window.showWarningMessage(
            '未找到 VS Code 用户级 mcp.json，stdio 配置已复制到剪贴板，请手动粘贴。'
          );
        }
        return;
      }

      const picked = await vscode.window.showQuickPick(
        [
          {
            label: '写入项目 .trae/mcp.json（HTTP，单项目）',
            value: 'project',
            description: '只对当前项目生效，需要开启项目级 MCP',
          },
          {
            label: '写入全局 Trae mcp.json（stdio，多窗口推荐）',
            value: 'global',
            description: '每个窗口自动连接各自项目的 ESMith，推荐',
          },
          {
            label: '复制项目 HTTP 配置',
            value: 'copyProject',
            description: '手动粘贴到项目 .trae/mcp.json',
          },
          {
            label: '复制全局 stdio 配置',
            value: 'copyGlobal',
            description: '手动粘贴到 Trae 全局 mcp.json',
          },
        ],
        { title: `注册 ESmith MCP（${hostLabel}）`, placeHolder: '选择注册方式' }
      );
      if (!picked) {
        return;
      }

      if (picked.value === 'project') {
        if (!url) {
          void vscode.window.showErrorMessage(
            'ESmith MCP Server 尚未启动。请确认 esmith.mcp.enabled 为 true，然后重新加载窗口。'
          );
          return;
        }
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage('当前没有打开工作区。');
          return;
        }
        const result = registerProjectMcp(workspaceRoot, url, timeoutMs);
        const action = await vscode.window.showInformationMessage(
          `已写入 ${result.path}。如未生效，请在 设置 > MCP 打开“启用项目级 MCP”，然后重新加载窗口。`,
          '打开文件',
          '复制配置'
        );
        if (action === '打开文件') {
          const document = await vscode.workspace.openTextDocument(result.path);
          await vscode.window.showTextDocument(document);
        } else if (action === '复制配置') {
          await vscode.env.clipboard.writeText(mcpConfigSnippet(url, timeoutMs));
        }
        return;
      }

      if (picked.value === 'global') {
        const result = registerGlobalMcp(context.extensionPath, 'trae');
        if (result) {
          void vscode.window.showInformationMessage(
            `已写入全局 stdio 配置 ${result.path}。重启 ${hostLabel} 后，每个窗口会自动连接各自项目的 ESMith。`
          );
        } else {
          await vscode.env.clipboard.writeText(
            stdioConfigSnippet(context.extensionPath, 'trae')
          );
          void vscode.window.showWarningMessage(
            '未找到 Trae 全局 mcp.json，stdio 配置已复制到剪贴板，请手动粘贴。'
          );
        }
        return;
      }

      if (picked.value === 'copyProject') {
        if (!url) {
          void vscode.window.showErrorMessage(
            'ESmith MCP Server 尚未启动。请确认 esmith.mcp.enabled 为 true，然后重新加载窗口。'
          );
          return;
        }
        await vscode.env.clipboard.writeText(mcpConfigSnippet(url, timeoutMs));
        void vscode.window.showInformationMessage('项目 HTTP 配置已复制到剪贴板。');
        return;
      }

      await vscode.env.clipboard.writeText(
        stdioConfigSnippet(context.extensionPath, 'trae')
      );
      void vscode.window.showInformationMessage('全局 stdio 配置已复制到剪贴板。');
    }),

    register('esmith.setupAgent', async () => {
      const workspaceRoot = runtime.getProjectRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage('当前没有打开工作区。');
        return;
      }
      const result = setupAgentIntegration(context, runtime, workspaceRoot);
      if (result.errors.length > 0) {
        const action = await vscode.window.showWarningMessage(
          `AI 集成部分失败（${result.hostLabel}）：${result.errors.join('；')}`,
          '显示输出'
        );
        if (action === '显示输出') {
          runtime.output.show();
        }
        return;
      }
      const action = await vscode.window.showInformationMessage(
        `已接入 AI（${result.hostLabel}）：MCP 配置 ${result.mcpPaths.length} 个，Agent 规则已生成。如未生效请重新加载窗口。`,
        '打开规则文件',
        '显示输出'
      );
      if (action === '打开规则文件' && result.rulesPath) {
        const document = await vscode.workspace.openTextDocument(result.rulesPath);
        await vscode.window.showTextDocument(document);
      } else if (action === '显示输出') {
        runtime.output.show();
      }
    }),

    register('esmith.installRules', async () => {
      const workspaceRoot = runtime.getProjectRoot();
      if (!workspaceRoot) {
        void vscode.window.showErrorMessage('当前没有打开工作区。');
        return;
      }
      try {
        const host = detectIdeHost();
        const filePath = installAgentRules(workspaceRoot, host);
        const action = await vscode.window.showInformationMessage(
          `已生成 Agent 规则：${filePath}`,
          '打开文件'
        );
        if (action === '打开文件') {
          const document = await vscode.workspace.openTextDocument(filePath);
          await vscode.window.showTextDocument(document);
        }
      } catch (error) {
        await showFailure(`生成 Agent 规则失败：${errorMessage(error)}`, runtime);
      }
    }),

    register('esmith.newProject', async () => {
      const environment = runtime.getIdfInfo() ?? (await runtime.refreshIdfInfo(true));
      if (!environment) {
        void vscode.window.showErrorMessage(
          '未找到 ESP-IDF。请先运行 ESMith: 集成体检，并确认官方 ESP-IDF 扩展已完成环境初始化。'
        );
        return;
      }

      const parentPick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '选择父目录',
        title: '选择新工程的父目录',
      });
      if (!parentPick || parentPick.length === 0) {
        return;
      }
      const parent = parentPick[0].fsPath;

      const name = await vscode.window.showInputBox({
        title: '新工程名称',
        prompt: '将在父目录下创建同名文件夹',
        value: 'esp32_app',
        validateInput: (value) =>
          sanitizeProjectName(value) === 'app' && !value.trim() ? '工程名称不能为空' : undefined,
      });
      if (!name) {
        return;
      }
      const projectName = sanitizeProjectName(name);
      const root = path.join(parent, projectName);
      if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
        void vscode.window.showErrorMessage(`目录已存在且非空：${root}`);
        return;
      }

      const templatePick = await vscode.window.showQuickPick<
        { label: string; description: string; value: 'blank' | 'blink' }
      >(
        [
          {
            label: 'Blank（Hello World）',
            description: '最小工程，串口打印 Hello from <工程名>!',
            value: 'blank',
          },
          {
            label: 'Blink（GPIO2）',
            description: '每 500ms 翻转 GPIO2，适合快速验证开发板',
            value: 'blink',
          },
        ],
        { title: '选择工程模板' }
      );
      if (!templatePick) {
        return;
      }

      const targetPick = await vscode.window.showQuickPick(
        COMMON_TARGETS.map((target) => ({ label: target })),
        { title: '选择目标芯片', placeHolder: '默认 esp32' }
      );
      if (!targetPick) {
        return;
      }

      const flashPick = await vscode.window.showQuickPick<
        { label: string; value: string | undefined }
      >(
        [
          { label: '不指定', value: undefined },
          { label: '2MB', value: '2MB' },
          { label: '4MB', value: '4MB' },
          { label: '8MB', value: '8MB' },
          { label: '16MB', value: '16MB' },
        ],
        { title: 'Flash 大小（可选）' }
      );
      if (!flashPick) {
        return;
      }

      try {
        fs.mkdirSync(root, { recursive: true });
        const result = initializeIdfProject({
          projectRoot: root,
          projectName,
          target: targetPick.label,
          template: templatePick.value,
          flashSize: flashPick.value,
          idfPath: environment.idfPath,
          idfVersion: environment.version,
        });
        const action = await vscode.window.showInformationMessage(
          `已创建 ${result.projectName}（${targetDisplayName(result.target)}）。`,
          '在新窗口打开',
          '添加到工作区'
        );
        if (action === '在新窗口打开') {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), {
            forceNewWindow: true,
          });
        } else if (action === '添加到工作区') {
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: vscode.Uri.file(root) }
          );
        }
      } catch (error) {
        await showFailure(`创建工程失败：${errorMessage(error)}`, runtime);
      }
    }),

    register('esmith.showSerial', () => {
      runtime.serialOutput.show(true);
    }),

    register('esmith.showMenu', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(run-all) 一键闭环', command: 'esmith.closedLoop' },
          { label: '$(checklist) 集成体检', command: 'esmith.doctor' },
          { label: '$(new-folder) 初始化当前文件夹', command: 'esmith.initProject' },
          { label: '$(folder-opened) 新建工程（选择父目录）', command: 'esmith.newProject' },
          { label: '$(terminal) 查看实时串口输出', command: 'esmith.showSerial' },
          { label: '$(plug) 接入 AI（MCP + Agent 规则）', command: 'esmith.setupAgent' },
          { label: '$(debug-disconnect) 清理残留 OpenOCD（3333）', command: 'esmith.cleanupOpenOcd' },
          { label: '$(output) 显示输出', command: 'esmith.showOutput' },
          { label: '$(refresh) 刷新 IDF 信息', command: 'esmith.refresh' },
          { label: '$(debug-stop) 停止当前任务', command: 'esmith.stop' },
        ],
        { title: 'ESmith 菜单', placeHolder: '选择操作' }
      );
      if (picked) {
        await vscode.commands.executeCommand(picked.command);
      }
    }),
  ];
}
