import * as vscode from 'vscode';
import { EsmithRuntimeImpl } from '../runtime';

type NodeKind = 'group' | 'info' | 'action';

interface EsmithNode {
  kind: NodeKind;
  label: string;
  description?: string;
  icon?: string;
  command?: vscode.Command;
  children?: EsmithNode[];
}

export class EsmithTreeProvider implements vscode.TreeDataProvider<EsmithNode> {
  private readonly emitter = new vscode.EventEmitter<EsmithNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly listener: vscode.Disposable;

  constructor(private readonly runtime: EsmithRuntimeImpl) {
    this.listener = runtime.onDidChangeState(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: EsmithNode): vscode.TreeItem {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('chip');
      return item;
    }
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    if (element.command) {
      item.command = element.command;
    }
    return item;
  }

  getChildren(element?: EsmithNode): EsmithNode[] {
    if (!element) {
      return this.rootNodes();
    }
    return element.children ?? [];
  }

  private rootNodes(): EsmithNode[] {
    const mcpUrl = this.runtime.getMcpUrl();

    return [
      {
        kind: 'group',
        label: '闭环',
        children: [
          {
            kind: 'action',
            label: '集成体检',
            icon: 'checklist',
            command: { command: 'esmith.doctor', title: '集成体检' },
          },
          {
            kind: 'action',
            label: '初始化当前文件夹',
            icon: 'new-folder',
            command: { command: 'esmith.initProject', title: '初始化工程' },
          },
          {
            kind: 'action',
            label: '新建工程（父目录）',
            icon: 'folder-opened',
            command: { command: 'esmith.newProject', title: '新建工程' },
          },
          {
            kind: 'action',
            label: '查看实时串口输出',
            icon: 'terminal',
            command: { command: 'esmith.showSerial', title: '串口输出' },
          },
        ],
      },
      {
        kind: 'group',
        label: 'AI 集成',
        children: [
          {
            kind: 'action',
            label: '注册 MCP 与 Agent 规则',
            icon: 'plug',
            command: { command: 'esmith.setupAgent', title: '注册 MCP 与 Agent 规则' },
          },
          {
            kind: 'info',
            label: 'MCP Server',
            description: mcpUrl ?? '未启动',
            icon: 'radio-tower',
          },
        ],
      },
      {
        kind: 'group',
        label: '维护',
        children: [
          {
            kind: 'action',
            label: '清理残留 OpenOCD（3333）',
            icon: 'debug-disconnect',
            command: { command: 'esmith.cleanupOpenOcd', title: '清理残留 OpenOCD' },
          },
          {
            kind: 'action',
            label: '显示输出',
            icon: 'output',
            command: { command: 'esmith.showOutput', title: '显示输出' },
          },
          {
            kind: 'action',
            label: '刷新 IDF 信息',
            icon: 'refresh',
            command: { command: 'esmith.refresh', title: '刷新 IDF 信息' },
          },
        ],
      },
    ];
  }

  dispose(): void {
    this.listener.dispose();
    this.emitter.dispose();
  }
}
