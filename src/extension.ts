import * as vscode from 'vscode';
import { installAgentRules } from './agent/rules';
import { esmithConfig, invalidateProjectFolderCache } from './config';
import { registerCommands } from './commands';
import { isEspIdfProject } from './core/project';
import { detectIdeHost, ideHostLabel } from './host';
import {
  hasProjectMcpEntry,
  mcpConfigSnippet,
  registerGlobalMcp,
  registerProjectMcp,
  registerVscodeProjectMcp,
} from './mcp/register';
import { registerServerInstance, unregisterServerInstance } from './mcp/registry';
import { McpGateway } from './mcp/server';
import { EsmithRuntimeImpl } from './runtime';
import { EsmithTreeProvider } from './ui/tree';
import { DoctorPanel } from './ui/doctorPanel';

let mcpGateway: McpGateway | undefined;
let registeredProjectRoot: string | undefined;

function releaseServerInstance(): void {
  if (registeredProjectRoot) {
    unregisterServerInstance(registeredProjectRoot);
    registeredProjectRoot = undefined;
  }
}

async function promptInstallEspIdf(): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    'ESmith 需要 ESP-IDF 扩展来提供工具链。是否安装 espressif.esp-idf-extension？',
    '安装',
    '打开扩展市场',
    '稍后'
  );
  if (action === '安装') {
    try {
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        'espressif.esp-idf-extension'
      );
    } catch {
      await vscode.commands.executeCommand(
        'workbench.extensions.search',
        'espressif.esp-idf-extension'
      );
    }
  } else if (action === '打开扩展市场') {
    await vscode.commands.executeCommand(
      'workbench.extensions.search',
      'espressif.esp-idf-extension'
    );
  }
}

async function startMcp(
  runtime: EsmithRuntimeImpl,
  context: vscode.ExtensionContext
): Promise<void> {
  const configuration = esmithConfig();
  if (!configuration.get<boolean>('mcp.enabled', true)) {
    runtime.output.appendLine('[mcp] 已在设置中禁用');
    return;
  }
  const host = configuration.get<string>('mcp.host', '127.0.0.1');
  const basePort = configuration.get<number>('mcp.port', 37821);
  const workspaceRoot = runtime.getProjectRoot();
  const port = preferredMcpPort(basePort, workspaceRoot);
  const gateway = new McpGateway(runtime);
  try {
    const url = await gateway.start({ host, port });
    mcpGateway = gateway;
    runtime.setMcpUrl(url);
    runtime.output.appendLine(`[mcp] ESmith MCP Server: ${url}`);
    runtime.output.appendLine(`[mcp] SSE 兼容端点: http://${host}:${gateway.port}/sse`);

    // 登记当前窗口实例，供全局 stdio 启动器在多根工作区下找到正确的工程。
    if (workspaceRoot) {
      try {
        const file = registerServerInstance(workspaceRoot, gateway.port);
        registeredProjectRoot = workspaceRoot;
        runtime.output.appendLine(`[mcp] 已登记实例 ${file}`);
      } catch (error) {
        runtime.output.appendLine(
          `[mcp] 实例登记失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const ideHost = detectIdeHost();
    const hostLabel = ideHostLabel(ideHost);
    runtime.output.appendLine(`[mcp] 宿主：${hostLabel}`);

    if (workspaceRoot) {
      const timeoutMs = configuration.get<number>('mcp.timeoutMs', 600000);
      // 只在 ESP-IDF 工程里自动写项目级 MCP 配置，避免把 .trae/.vscode 配置
      // 注入到任意普通项目；已有 esmith 入口说明用户显式配置过，继续同步。
      const isIdfProject = isEspIdfProject(workspaceRoot);
      const hasEntry = hasProjectMcpEntry(workspaceRoot, ideHost);
      const shouldWrite =
        (configuration.get<boolean>('mcp.autoRegister', true) && isIdfProject) ||
        hasEntry;
      if (!shouldWrite && configuration.get<boolean>('mcp.autoRegister', true)) {
        runtime.output.appendLine(
          '[mcp] 当前不是 ESP-IDF 工程，跳过项目级 MCP 配置写入'
        );
      }
      if (shouldWrite) {
        const result =
          ideHost === 'vscode'
            ? registerVscodeProjectMcp(workspaceRoot, context.extensionPath)
            : registerProjectMcp(workspaceRoot, url, timeoutMs);
        runtime.output.appendLine(`[mcp] 已同步 ${result.path}`);

        const noticeKey = `esmith.mcp.notice.${ideHost}.${workspaceRoot}`;
        if (!context.workspaceState.get<boolean>(noticeKey, false)) {
          void vscode.window
            .showInformationMessage(
              `ESmith MCP 已注册（${hostLabel}）。重新加载窗口后，Agent 会自动连接当前项目的 ESMith。`,
              '打开设置',
              '复制配置'
            )
            .then(async (action) => {
              if (action === '打开设置') {
                await vscode.commands.executeCommand(
                  'workbench.action.openSettings',
                  'mcp'
                );
              } else if (action === '复制配置') {
                await vscode.env.clipboard.writeText(
                  ideHost === 'vscode'
                    ? JSON.stringify(result.config, null, 2)
                    : mcpConfigSnippet(url, timeoutMs)
                );
              }
            });
          await context.workspaceState.update(noticeKey, true);
        }
      }

      if (
        configuration.get<boolean>('agentRules.autoInstall', true) &&
        isEspIdfProject(workspaceRoot)
      ) {
        try {
          const rulePath = installAgentRules(workspaceRoot, ideHost);
          runtime.output.appendLine(`[rules] 已生成 ${rulePath}`);
        } catch (error) {
          runtime.output.appendLine(
            `[rules] 生成失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    // Trae 的全局 stdio 入口用于多窗口；VS Code 使用项目级 .vscode/mcp.json，无需全局写死。
    if (
      ideHost === 'trae' &&
      configuration.get<boolean>('mcp.autoRegisterGlobal', true)
    ) {
      const global = registerGlobalMcp(context.extensionPath, 'trae');
      if (global) {
        runtime.output.appendLine(`[mcp] 已同步全局 stdio 入口 ${global.path}`);
      }
    }
  } catch (error) {
    runtime.output.appendLine(
      `[mcp] 启动失败：${error instanceof Error ? error.message : String(error)}`
    );
    void vscode.window.showErrorMessage(
      `ESmith MCP Server 启动失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * 与 resources/mcp-stdio.js 的 normalizePath 保持一致，
 * 否则两边算出的稳定端口会不同。
 */
function normalizeWorkspacePath(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return value
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 每个工作区使用稳定的端口，避免多个 Trae 窗口互相占用端口导致
 * .trae/mcp.json 指向错误的窗口。
 */
function preferredMcpPort(basePort: number, workspaceRoot: string | undefined): number {
  if (!workspaceRoot || basePort <= 0) {
    return basePort;
  }
  let hash = 5381;
  const normalized = normalizeWorkspacePath(workspaceRoot);
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(index);
    hash >>>= 0;
  }
  return basePort + (hash % 200);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runtime = new EsmithRuntimeImpl(context);
  context.subscriptions.push(runtime);
  context.subscriptions.push({ dispose: () => DoctorPanel.dispose() });

  const tree = new EsmithTreeProvider(runtime);
  const treeView = vscode.window.createTreeView('esmith.explorer', {
    treeDataProvider: tree,
  });
  context.subscriptions.push(tree, treeView);

  context.subscriptions.push(...registerCommands(context, runtime));

  if (!vscode.extensions.getExtension('espressif.esp-idf-extension')) {
    void promptInstallEspIdf();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('esmith.idfPath') || event.affectsConfiguration('idf.currentSetup')) {
        await runtime.refreshIdfInfo(true);
        return;
      }
      if (
        event.affectsConfiguration('esmith.mcp.enabled') ||
        event.affectsConfiguration('esmith.mcp.port') ||
        event.affectsConfiguration('esmith.mcp.host')
      ) {
        void vscode.window
          .showInformationMessage('ESmith MCP 配置已变更，请重新加载窗口以生效。', '重新加载')
          .then((action) => {
            if (action === '重新加载') {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      invalidateProjectFolderCache();
      await runtime.refreshIdfInfo(true);
      // 多根工作区新增/移除文件夹后，当前窗口可能对应另一个 IDF 工程。
      const root = runtime.getProjectRoot();
      if (mcpGateway && root && root !== registeredProjectRoot) {
        releaseServerInstance();
        try {
          registerServerInstance(root, mcpGateway.port);
          registeredProjectRoot = root;
        } catch (error) {
          runtime.output.appendLine(
            `[mcp] 实例重新登记失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      tree.refresh();
    })
  );

  await runtime.refreshIdfInfo();
  await startMcp(runtime, context);

  context.subscriptions.push({
    dispose: () => {
      releaseServerInstance();
      void mcpGateway?.stop();
      mcpGateway = undefined;
    },
  });
}

export function deactivate(): void {
  releaseServerInstance();
  void mcpGateway?.stop();
  mcpGateway = undefined;
}
