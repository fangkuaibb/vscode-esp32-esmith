import * as fs from 'fs';
import * as path from 'path';
import type { IdeHost } from '../host';

const AGENTS_FILE = 'AGENTS.md';
const RULE_FILE = 'esmith.md';
const MARKER_START = '<!-- ESMITH:START -->';
const MARKER_END = '<!-- ESMITH:END -->';

function ruleBody(): string {
  return `# ESmith ESP32 闭环工作流

## 环境信息
- 不要硬编码 IDF 路径、串口或芯片型号。需要时先调用 \`esmith_project_info\` 获取。
- 构建、烧录、切换目标统一由 ESmith 调用官方 ESP-IDF 扩展执行；不要自己拼 IDF 环境或直接运行 \`idf.py\`。
- 环境异常时先调用 \`esmith_doctor\`，不要自行安装、修复或重装 ESP-IDF。
- 串口列表用 \`esmith_list_ports\` 查询；烧录前确认串口没有被其他监视器占用。

## 标准闭环
1. 阅读并修改项目代码。
2. 需要编译时调用 \`esmith_build\`。不要传 target，除非用户明确要求切换芯片。
3. 修改完成后优先调用 \`esmith_closed_loop\`，它会执行编译 → 烧录 → 复位 → 串口验证。
4. 如果失败：
   - 先调用 \`esmith_query_experience\` 查询历史疑难修复经验。
   - 编译失败：读取返回的 \`diagnostics\`，修复后重新调用 \`esmith_closed_loop\`。
   - 运行崩溃：读取 \`serial.crash.signature\` 与 \`serial.crash.context\`。
   - 没有输出或特征不匹配：读取 \`serial.tail\`，检查供电、TX/RX、波特率、串口占用和 \`expected_pattern\`。
   - 烧录方式由 \`idf.flashType\` 决定（UART / JTAG / DFU），不要假设一定是 UART。
5. 如果某次修复明显不属于普通编译错误，并且验证通过，调用
   \`esmith_record_experience\` 记录 trigger / fix / lesson，供后续复用。
6. 需要持续观察日志时：
   - \`esmith_monitor_start\` 打开串口；
   - \`esmith_serial_tail\` / \`esmith_serial_search\` 读取历史；
   - \`esmith_reset_device\` 复位；
   - 烧录前先 \`esmith_monitor_stop\` 释放串口。
   - 闭环采样时用户可在 “ESmith Serial” 输出面板同步观察。

## 调试与崩溃定位
1. 需要断点、单步或查看现场时，调用 \`esmith_debug_start\`（默认停在 \`app_main\`）。
2. 常用工具：
   - \`esmith_breakpoint_set\` / \`esmith_breakpoint_clear\` / \`esmith_breakpoint_list\`
   - \`esmith_debug_control\`（continue / pause / step_over / step_in / step_out / reset / reset_run / reset_to_app）
   - \`esmith_debug_state\`、\`esmith_threads\`、\`esmith_backtrace\`、\`esmith_registers\`
   - \`esmith_read_variable\`、\`esmith_memory_read\` / \`esmith_memory_write\`
   - \`esmith_watchpoint_set\` / \`esmith_watchpoint_list\` / \`esmith_watchpoint_clear\`（数据断点）
   - \`esmith_gdb_command\`（适配器未封装的高级 GDB 命令）
3. 调试结束后调用 \`esmith_debug_stop\`。
4. core 文件用 \`esmith_coredump_analyze\` 分析，分析前先停止调试会话。
5. 调试期间不要调用 \`esmith_build\` / \`esmith_flash\` / \`esmith_closed_loop\`；烧录前必须先停止调试。

## JTAG 常见问题
- \`JTAG tap: esp32c3.tap0 ... UNEXPECTED: 0x00005c25\`：这是 OpenOCD 20260304 包把 \`_CPUTAPID\` 误写成 Xtensa ID 的工具链 Bug；ESmith 会在调试/烧录前按同包 \`esp-config.json\` 自动修正（备份 \`.esmith-bak\`），不要据此判断硬件故障。
- 出现 \`IN buffer overflow\`：先断电或重插开发板，再把 \`esmith.openocd.adapterSpeed\` 降到 1000（或更低）；不要连续重试。
- JTAG 烧录通常需要数秒，ESmith 会轮询 \`Flashed Successfully\` / \`[/Flash]\` 完成标记；不要手动中断。
- JTAG 烧录结果中的 \`flashConfidence\`：\`verified\` 表示日志已确认，\`unconfirmed\` 仍需以串口验证为准。
- 多块板同时在线时，以官方扩展选中的 COM 口（\`idf.port\`）为准；ESmith 会解析成 OpenOCD USB 位置。

## 并发与超时
- \`esmith_build\`、\`esmith_flash\`、\`esmith_closed_loop\` 都是长任务，同一时间只能执行一个。
- 如果返回 "任务已取消" 或 "另一个任务正在运行"，等待当前任务结束，不要重复并发调用。
- 不要因为等待时间长就重复发送同一个工具调用。

## 禁止事项
- 禁止直接调用 \`idf.py\`、\`esptool.py\`、\`openocd\`、\`gdb\` 等底层命令，统一通过 ESmith 工具。
- 禁止调用 \`espsmith-cli.exe\` 或其他外部 CLI，所有 ESP32 操作统一走 ESmith MCP。
- 禁止自行修改 ESP-IDF 安装、Python 虚拟环境或工具链。
- 单元测试优先调用 \`esmith_unit_test\`，由官方 ESP-IDF 扩展执行 Unity 测试应用的构建/烧录。
- 第三方组件优先使用 IDF Component Manager：在 \`main/idf_component.yml\` 声明依赖，并在 \`main/CMakeLists.txt\` 的 \`idf_component_register(... REQUIRES ...)\` 中引用。

## 结果汇报
- 每次工具调用完成后，用中文向用户汇报：成功/失败、阶段、关键日志、下一步。
`;
}

/**
 * 根目录 AGENTS.md 是唯一的规则源：Codex 等智能体默认读取它。
 * 用标记块合并，避免覆盖用户已有内容；重复执行只更新标记块。
 */
function installAgentsFile(workspaceRoot: string): string {
  const filePath = path.join(workspaceRoot, AGENTS_FILE);
  const body = ruleBody().trim();
  const block = `${MARKER_START}\n${body}\n${MARKER_END}\n`;

  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  }
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MARKER_END.length).replace(/^\n+/, '\n');
    existing = `${before}${block}${after}`;
  } else {
    existing = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;
  }
  fs.writeFileSync(filePath, existing, 'utf8');
  return filePath;
}

/**
 * Trae 只放一个指针规则，具体内容统一在根目录 AGENTS.md。
 */
function installTraeRule(workspaceRoot: string): string {
  const rulesDir = path.join(workspaceRoot, '.trae', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const filePath = path.join(rulesDir, RULE_FILE);
  const content = `---
description: ESP32/ESP-IDF 闭环开发规则（ESmith）
alwaysApply: true
---

# ESmith

本工程的 Agent 规则统一维护在根目录 \`AGENTS.md\`（相对路径 \`../../AGENTS.md\`）。
执行任何 ESP32 构建、烧录、串口或调试操作前，请先读取该文件并按其约定使用 ESmith MCP 工具。
`;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * VS Code 使用 .github/copilot-instructions.md。
 * 保留完整内容（Copilot 不保证读取 AGENTS.md）。
 */
function installCopilotRules(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, '.github');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'copilot-instructions.md');
  const block = `${MARKER_START}\n${ruleBody().trim()}\n${MARKER_END}\n`;

  let existing = '';
  if (fs.existsSync(filePath)) {
    existing = fs.readFileSync(filePath, 'utf8');
  }
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MARKER_END.length).replace(/^\n+/, '\n');
    existing = `${before}${block}${after}`;
  } else {
    existing = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}`;
  }
  fs.writeFileSync(filePath, existing, 'utf8');
  return filePath;
}

/**
 * 安装 Agent 规则。
 * - 始终写根目录 AGENTS.md（Codex 等智能体）
 * - Trae：.trae/rules/esmith.md 仅指向 AGENTS.md
 * - VS Code：.github/copilot-instructions.md 保留完整内容
 *
 * @returns 规则主文件（AGENTS.md）的路径
 */
export function installAgentRules(
  workspaceRoot: string,
  host: IdeHost = 'trae'
): string {
  const agentsPath = installAgentsFile(workspaceRoot);
  if (host === 'vscode') {
    installCopilotRules(workspaceRoot);
  } else {
    installTraeRule(workspaceRoot);
  }
  return agentsPath;
}
