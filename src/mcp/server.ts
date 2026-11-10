import * as http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { EsmithRuntime } from './runtime';

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function invoke(fn: () => unknown, isDomainResult = false) {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      !isDomainResult
    );
  }
}

function createServer(runtime: EsmithRuntime): McpServer {
  const server = new McpServer({
    name: 'esmith',
    version: '0.1.0',
    title: 'ESmith ESP32 Closed-Loop Tools',
  });

  // SDK 的 registerTool 泛型在复杂返回值下会触发 TS2589，
  // 这里使用一个窄化的注册器，工具参数在回调内部按需解构。
  type ToolRegistrar = (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    },
    handler: (args: any) => unknown
  ) => unknown;
  const register = server.registerTool.bind(server) as unknown as ToolRegistrar;

  register(
    'esmith_project_info',
    {
      title: 'ESmith 项目信息',
      description:
        '获取当前 ESP-IDF 工程、IDF 路径/版本、目标芯片、串口、串口监视状态和 MCP 地址。开始任何 ESP32 任务前建议先调用。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.getProjectInfo())
  );

  register(
    'esmith_doctor',
    {
      title: 'ESmith 集成体检',
      description:
        '检查官方 ESP-IDF 扩展及其命令、ESP-IDF 工程、目标芯片、串口与 MCP 服务状态。环境异常时先调用。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.doctor())
  );

  register(
    'esmith_list_ports',
    {
      title: 'ESmith 串口列表',
      description: '列出可用串口，并标记疑似 ESP32 设备（USB-JTAG、CP210x、CH340、FTDI）。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.listPorts())
  );

  register(
    'esmith_init_project',
    {
      title: 'ESmith 初始化工程',
      description:
        '将当前工作区根目录初始化为 ESP-IDF 工程（CMakeLists、main、sdkconfig.defaults、.espsmith 元信息和 Agent 规则）。仅在用户明确要求新建或初始化工程时调用；不会覆盖已有文件。',
      inputSchema: {
        target: z.string().optional().describe('目标芯片，默认 esp32'),
        template: z
          .enum(['blank', 'blink'])
          .optional()
          .describe('blank = Hello World；blink = GPIO2 每 500ms 翻转'),
        project_name: z.string().optional().describe('工程名，默认使用文件夹名'),
        flash_size: z
          .string()
          .optional()
          .describe('Flash 大小：2MB / 4MB / 8MB / 16MB，可选'),
      },
    },
    async ({ target, template, project_name, flash_size }) =>
      invoke(() =>
        runtime.initializeProject({
          target,
          template,
          projectName: project_name,
          flashSize: flash_size,
        })
      )
  );

  register(
    'esmith_set_target',
    {
      title: 'ESmith 设置目标芯片',
      description:
        '调用官方 ESP-IDF 扩展的 setTarget 切换芯片。会触发完全重新配置，速度较慢；只有用户明确要求切换芯片时才调用。',
      inputSchema: {
        target: z.string().describe('目标芯片，例如 esp32、esp32s3、esp32c3、esp32c6、esp32p4'),
      },
    },
    async ({ target }) => invoke(() => runtime.setTarget(target))
  );

  register(
    'esmith_build',
    {
      title: 'ESmith 编译',
      description:
        '调用官方 ESP-IDF 扩展的 buildDevice 执行构建，返回 VS Code Problems 中的结构化诊断。仅需编译检查时使用；不要与 flash / closed_loop 并发调用。',
      inputSchema: {
        clean: z.boolean().optional().describe('是否先执行 fullclean，默认 false'),
        timeout_ms: z.number().int().positive().optional().describe('编译超时，默认 30 分钟'),
      },
    },
    async ({ clean, timeout_ms }) =>
      invoke(() => runtime.build({ clean, timeoutMs: timeout_ms }))
  );

  register(
    'esmith_flash',
    {
      title: 'ESmith 烧录',
      description:
        '调用官方 ESP-IDF 扩展的 flashUart 烧录固件。修改代码后通常直接调用 esmith_closed_loop，不需要单独调用本工具。',
      inputSchema: {
        port: z.string().optional().describe('串口，例如 COM5 或 /dev/ttyUSB0；留空自动检测'),
        baud: z.number().int().positive().optional().describe('烧录波特率，默认 460800'),
      },
    },
    async ({ port, baud }) => invoke(() => runtime.flash({ port, baud }))
  );

  register(
    'esmith_monitor_start',
    {
      title: 'ESmith 打开串口监视',
      description: '打开常驻串口监视器，日志进入环形缓冲，可用 esmith_serial_tail/search 读取。',
      inputSchema: {
        port: z.string().optional().describe('串口；留空使用当前端口或自动检测'),
        baud: z.number().int().positive().optional().describe('波特率，默认 115200'),
      },
    },
    async ({ port, baud }) => invoke(() => runtime.monitorStart(port, baud))
  );

  register(
    'esmith_monitor_stop',
    {
      title: 'ESmith 关闭串口监视',
      description: '关闭常驻串口监视器，释放串口。烧录前如串口被占用可调用。',
      inputSchema: {},
    },
    async () =>
      invoke(async () => {
        await runtime.monitorStop();
        return { success: true };
      })
  );

  register(
    'esmith_serial_tail',
    {
      title: 'ESmith 读取串口尾部',
      description:
        '从环形缓冲读取最近的串口日志，零延迟、不重新打开串口。推荐在 monitor_start 后使用。',
      inputSchema: {
        lines: z.number().int().positive().optional().describe('读取行数，默认 200，最大 2000'),
        since_ms: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('只返回该时间戳之后的日志（可用上次返回的 latestTsMs）'),
      },
    },
    async ({ lines, since_ms }) =>
      invoke(() => runtime.serialTail(Math.min(lines ?? 200, 2000), since_ms))
  );

  register(
    'esmith_serial_search',
    {
      title: 'ESmith 搜索串口日志',
      description: '用正则搜索环形缓冲中的串口历史，适合定位崩溃前日志或特定事件。',
      inputSchema: {
        pattern: z.string().describe('正则表达式，例如 error、WiFi.*connect、Guru Meditation'),
        limit: z.number().int().positive().optional().describe('最多返回条数，默认 50'),
      },
    },
    async ({ pattern, limit }) =>
      invoke(() => runtime.serialSearch(pattern, Math.min(limit ?? 50, 500)))
  );

  register(
    'esmith_serial_send',
    {
      title: 'ESmith 向串口发送数据',
      description: '向设备发送一行文本（自动追加换行），需要串口监视器已打开。',
      inputSchema: {
        data: z.string().describe('要发送的文本'),
      },
    },
    async ({ data }) =>
      invoke(async () => {
        await runtime.serialSend(data);
        return { success: true };
      })
  );

  register(
    'esmith_reset_device',
    {
      title: 'ESmith 复位设备',
      description: '通过 DTR/RTS 复位 ESP32。串口监视器已打开时也可使用，复位后的启动日志会被捕获。',
      inputSchema: {},
    },
    async () =>
      invoke(async () => {
        await runtime.resetDevice();
        return { success: true };
      })
  );

  register(
    'esmith_query_experience',
    {
      title: 'ESmith 查询经验',
      description:
        '在项目 .esmith/experience/skills 中检索历史疑难修复经验。闭环失败或遇到相似错误时先查询，避免重复试错。',
      inputSchema: {
        query: z.string().describe('错误信息、崩溃签名或问题关键词'),
        limit: z.number().int().positive().optional().describe('最多返回条数，默认 5'),
      },
    },
    async ({ query, limit }) =>
      invoke(() => runtime.queryExperience(query, Math.min(limit ?? 5, 20)))
  );

  register(
    'esmith_record_experience',
    {
      title: 'ESmith 记录经验',
      description:
        '记录一次疑难修复经验（trigger 问题特征、fix 修复方式、lesson 结论）。只在确实解决了非普通编译错误时调用，不要记录源码或密钥。',
      inputSchema: {
        trigger: z.string().describe('问题特征，例如崩溃签名或错误日志片段'),
        fix: z.string().describe('实际生效的修复方式'),
        lesson: z.string().describe('可复用的结论'),
        scope: z.string().optional().describe('适用范围，例如 esp32s3 / wifi / dma'),
      },
    },
    async ({ trigger, fix, lesson, scope }) =>
      invoke(() => runtime.recordExperience({ trigger, fix, lesson, scope }))
  );

  register(
    'esmith_unit_test',
    {
      title: 'ESmith 单元测试应用',
      description:
        '调用官方 ESP-IDF 扩展的 Unity 单元测试应用命令（构建/烧录/构建并烧录）。',
      inputSchema: {
        mode: z
          .enum(['build', 'flash', 'build-flash'])
          .optional()
          .describe('build = 仅构建；flash = 仅烧录；build-flash = 构建并烧录（默认）'),
      },
    },
    async ({ mode }) => invoke(() => runtime.runUnitTest(mode ?? 'build-flash'))
  );

  // ── 调试与崩溃定位（gdbtarget DAP） ─────────────────────────────

  register(
    'esmith_debug_start',
    {
      title: 'ESmith 启动调试',
      description:
        '通过 vscode.debug 启动官方 ESP-IDF 扩展的 gdbtarget 会话（由官方扩展管理 OpenOCD/GDB）。默认停在 app_main。已有调试会话时需先停止。',
      inputSchema: {
        port: z
          .string()
          .optional()
          .describe(
            'COM3 等串口作为调试串口；纯数字作为 GDB server 端口（默认 3333，非 3333 表示复用已有 OpenOCD）'
          ),
        halt_on_entry: z.boolean().optional().describe('是否在 app_main 停下，默认 true'),
        openocd_cfg: z
          .string()
          .optional()
          .describe('OpenOCD 配置列表，逗号分隔，例如 board/esp32s3-builtin.cfg'),
        gdb_commands: z
          .array(z.string())
          .optional()
          .describe('连接后执行的 GDB 命令列表'),
        elf_path: z.string().optional().describe('ELF 路径，默认使用 build 目录产物'),
      },
    },
    async ({ port, halt_on_entry, openocd_cfg, gdb_commands, elf_path }) =>
      invoke(() =>
        runtime.debugStart({
          port,
          haltOnEntry: halt_on_entry,
          openocdCfg: openocd_cfg,
          gdbCommands: gdb_commands,
          elfPath: elf_path,
        })
      )
  );

  register(
    'esmith_debug_stop',
    {
      title: 'ESmith 停止调试',
      description: '停止 ESmith 启动的 gdbtarget 调试会话，并释放 OpenOCD。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.debugStop())
  );

  register(
    'esmith_debug_state',
    {
      title: 'ESmith 调试现场',
      description:
        '返回调试会话状态：运行/停止、停止原因、线程、当前 PC/文件行号、断点列表和调试控制台尾部。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.debugState())
  );

  register(
    'esmith_breakpoint_set',
    {
      title: 'ESmith 设置断点',
      description:
        '设置源码断点（file:line）、函数断点或地址断点（0x...），支持条件、命中次数和日志断点。',
      inputSchema: {
        location: z.string().describe('file:line、函数名或 0x地址'),
        condition: z.string().optional().describe('条件表达式，例如 count > 10'),
        hit_count: z.number().int().positive().optional().describe('命中多少次后停下'),
        log_message: z
          .string()
          .optional()
          .describe('日志断点：命中时打印该文本并继续，不中断运行'),
        temporary: z.boolean().optional().describe('一次性断点'),
        hardware: z.boolean().optional().describe('硬件断点'),
        disabled: z.boolean().optional().describe('创建后禁用'),
      },
    },
    async ({ location, condition, hit_count, log_message, temporary, hardware, disabled }) =>
      invoke(() =>
        runtime.breakpointSet({
          location,
          condition,
          hitCount: hit_count,
          logMessage: log_message,
          temporary,
          hardware,
          disabled,
        })
      )
  );

  register(
    'esmith_breakpoint_clear',
    {
      title: 'ESmith 清除断点',
      description: '按 id 删除断点，或 all=true 清除全部断点。',
      inputSchema: {
        id: z.string().optional().describe('断点 id'),
        all: z.boolean().optional().describe('清除全部断点'),
      },
    },
    async ({ id, all }) => invoke(() => runtime.breakpointClear({ id, all }))
  );

  register(
    'esmith_breakpoint_list',
    {
      title: 'ESmith 断点列表',
      description: '列出当前调试会话中 ESmith 管理的断点。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.breakpointList())
  );

  register(
    'esmith_debug_control',
    {
      title: 'ESmith 运行控制',
      description:
        '调试运行控制：continue / pause / step_over / step_in / step_out / reset（复位并暂停）/ reset_run（复位并运行）/ reset_to_app（复位并停在 app_main）。',
      inputSchema: {
        action: z
          .enum([
            'continue',
            'pause',
            'step_over',
            'step_in',
            'step_out',
            'reset',
            'reset_run',
            'reset_to_app',
          ])
          .describe('控制动作'),
      },
    },
    async ({ action }) => invoke(() => runtime.debugControl(action))
  );

  register(
    'esmith_backtrace',
    {
      title: 'ESmith 调用栈',
      description: '读取当前线程（或指定线程）的调用栈。',
      inputSchema: {
        depth: z.number().int().positive().optional().describe('栈帧数量，默认 20'),
        thread: z.string().optional().describe('线程 id'),
      },
    },
    async ({ depth, thread }) => invoke(() => runtime.backtrace({ depth, thread }))
  );

  register(
    'esmith_registers',
    {
      title: 'ESmith 寄存器',
      description:
        '读取指定线程/核当前栈帧的寄存器。优先使用调试器的 Registers scope，否则按芯片架构逐个 evaluate。',
      inputSchema: {
        filter: z.string().optional().describe('按寄存器名过滤，例如 pc / a0 / sp'),
        thread: z.string().optional().describe('线程 id（见 esmith_threads），默认当前线程'),
      },
    },
    async ({ filter, thread }) => invoke(() => runtime.registers(filter, thread))
  );

  register(
    'esmith_threads',
    {
      title: 'ESmith 线程/核列表',
      description:
        '列出调试器可见的线程（FreeRTOS task / CPU 核），用于 backtrace / registers 的 thread 参数。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.debugThreads())
  );

  register(
    'esmith_read_variable',
    {
      title: 'ESmith 读取变量',
      description: '在当前栈帧或指定栈帧中求值变量/表达式。',
      inputSchema: {
        expression: z.string().describe('变量名或表达式'),
        frame: z.number().int().nonnegative().optional().describe('栈帧序号，默认当前帧'),
      },
    },
    async ({ expression, frame }) =>
      invoke(() => runtime.readVariable({ expression, frame }))
  );

  register(
    'esmith_memory_read',
    {
      title: 'ESmith 读取内存',
      description: '从调试目标读取内存，返回十六进制和 ASCII。',
      inputSchema: {
        address: z.string().describe('地址，例如 0x3fc90000'),
        length: z.number().int().positive().describe('字节数，最大 65536'),
      },
    },
    async ({ address, length }) =>
      invoke(() => runtime.memoryRead({ address, length }))
  );

  register(
    'esmith_memory_write',
    {
      title: 'ESmith 写入内存',
      description: '向调试目标写入内存。data 为偶数长度十六进制或普通文本。',
      inputSchema: {
        address: z.string().describe('地址，例如 0x3fc90000'),
        data: z.string().describe('十六进制字节串或文本'),
      },
    },
    async ({ address, data }) =>
      invoke(() => runtime.memoryWrite({ address, data }))
  );

  register(
    'esmith_watchpoint_set',
    {
      title: 'ESmith 数据断点',
      description:
        '通过 GDB REPL 设置硬件监视点（watch / rwatch / awatch）。expression 或 address 至少传一个；命中时程序会停在访问该地址的指令上。',
      inputSchema: {
        expression: z.string().optional().describe('变量或表达式，例如 phase'),
        address: z.string().optional().describe('地址，例如 0x3fc90000'),
        mode: z.enum(['read', 'write', 'access']).optional().describe('默认 write'),
      },
    },
    async ({ expression, address, mode }) =>
      invoke(() =>
        runtime.watchpointSet({
          expression,
          address,
          mode: mode ?? 'write',
        })
      )
  );

  register(
    'esmith_watchpoint_list',
    {
      title: 'ESmith 监视点列表',
      description: '列出通过 ESmith 设置的数据断点，以及最近一次停止原因（判断是否命中监视点）。',
      inputSchema: {},
    },
    async () => invoke(() => runtime.watchpointList())
  );

  register(
    'esmith_watchpoint_clear',
    {
      title: 'ESmith 清除监视点',
      description: '按 id（或 GDB watchpoint 编号）清除数据断点；all=true 清除全部。',
      inputSchema: {
        id: z.string().optional().describe('监视点 id 或 GDB watchpoint 编号'),
        all: z.boolean().optional().describe('清除全部监视点'),
      },
    },
    async ({ id, all }) => invoke(() => runtime.watchpointClear({ id, all }))
  );

  register(
    'esmith_gdb_command',
    {
      title: 'ESmith GDB 命令',
      description:
        '在调试会话中执行 GDB 命令（REPL 通道）。支持 info threads、monitor reset halt、x/4wx 0x3fc90000、set var、p/x 等；目标正在运行时先自动暂停。以 - 开头会按 MI 命令发送。',
      inputSchema: {
        command: z.string().describe('GDB 命令，例如 info threads 或 monitor reset halt'),
      },
    },
    async ({ command }) => invoke(() => runtime.gdbCommand({ command }))
  );

  register(
    'esmith_coredump_analyze',
    {
      title: 'ESmith Core Dump 分析',
      description:
        '用 gdbtarget 会话加载 ELF + core 文件，输出每个线程的调用栈。分析前需停止现有调试会话。',
      inputSchema: {
        core_path: z.string().describe('core 文件绝对路径'),
        elf_path: z.string().optional().describe('ELF 路径，默认 build 产物'),
        target: z.string().optional().describe('目标芯片；默认从 sdkconfig 读取'),
      },
    },
    async ({ core_path, elf_path, target }) =>
      invoke(() =>
        runtime.coredumpAnalyze({
          corePath: core_path,
          elfPath: elf_path,
          target,
        })
      )
  );

  register(
    'esmith_closed_loop',
    {
      title: 'ESmith 一键闭环',
      description:
        '执行 preflight → 官方 ESP-IDF 扩展构建 → 官方扩展烧录 → 复位 → 串口验证。修改代码后优先调用本工具。失败时读取 diagnostics、serial.crash、serial.tail 修复代码后重试。不要与 build/flash 并发调用。',
      inputSchema: {
        port: z.string().optional().describe('串口；留空使用当前端口或自动检测'),
        baud: z.number().int().positive().optional().describe('串口监视波特率，默认 115200'),
        expected_pattern: z
          .string()
          .optional()
          .describe('期望出现在串口输出中的字符串，例如 "Hello World" 或 "LED ON"'),
        monitor_ms: z.number().int().positive().optional().describe('串口采样时长，默认 5000ms'),
        retries: z.number().int().nonnegative().optional().describe('烧录/验证重试次数，默认 2'),
        target: z.string().optional().describe('目标芯片；通常不需要传，自动读取 sdkconfig'),
        clean: z.boolean().optional().describe('是否先 fullclean，默认 false'),
      },
    },
    async ({ port, baud, expected_pattern, monitor_ms, retries, target, clean }) =>
      invoke(
        () =>
          runtime.closedLoop({
            port,
            expectedPattern: expected_pattern,
            monitorMs: monitor_ms,
            retries,
            target,
            clean,
            keepMonitor: false,
          }),
        true
      )
  );

  register(
    'esmith_stop',
    {
      title: 'ESmith 停止当前任务',
      description: '取消当前正在执行的编译、烧录或闭环任务。',
      inputSchema: {},
    },
    async () =>
      invoke(async () => {
        runtime.stop();
        return { success: true, message: '已请求停止当前任务' };
      })
  );

  return server;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isInitializeMessage(parsed: unknown): boolean {
  if (Array.isArray(parsed)) {
    return parsed.some(
      (message) => (message as { method?: string } | undefined)?.method === 'initialize'
    );
  }
  return (parsed as { method?: string } | undefined)?.method === 'initialize';
}

function listen(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export interface McpGatewayOptions {
  host: string;
  port: number;
}

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export class McpGateway {
  private server?: http.Server;
  private readonly sessions = new Map<string, StreamableSession>();
  private readonly sseSessions = new Map<
    string,
    { server: McpServer; transport: SSEServerTransport }
  >();
  private lastSessionId?: string;
  private actualPort = 0;

  constructor(private readonly runtime: EsmithRuntime) {}

  get url(): string | undefined {
    return this.actualPort > 0 ? `http://127.0.0.1:${this.actualPort}/mcp` : undefined;
  }

  get port(): number {
    return this.actualPort;
  }

  async start(options: McpGatewayOptions): Promise<string> {
    if (this.server) {
      return this.url ?? '';
    }
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    let port = options.port;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        port = await listen(server, options.host, options.port + attempt);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' || attempt === 19) {
          throw error;
        }
      }
    }
    this.server = server;
    this.actualPort = port;

    // 每个客户端会话使用独立的 Streamable HTTP transport，
    // 支持多个 Trae 会话/客户端同时连接同一个 ESMith。
    return this.url ?? '';
  }

  async stop(): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      this.sessions.delete(sessionId);
      try {
        await session.transport.close();
      } catch {
        // ignore
      }
      try {
        await session.server.close();
      } catch {
        // ignore
      }
    }
    this.lastSessionId = undefined;

    for (const [sessionId, session] of this.sseSessions) {
      this.sseSessions.delete(sessionId);
      try {
        await session.transport.close();
      } catch {
        // ignore
      }
      try {
        await session.server.close();
      } catch {
        // ignore
      }
    }
    const server = this.server;
    this.server = undefined;
    this.actualPort = 0;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      jsonResponse(response, 200, {
        ok: true,
        name: 'esmith',
        version: '0.1.0',
        mcp: this.url,
        projectRoot: this.runtime.getProjectRoot(),
      });
      return;
    }

    if (url.pathname === '/mcp') {
      try {
        await this.handleMcpRequest(request, response);
      } catch (error) {
        console.error('[esmith-mcp] request failed:', error);
        if (!response.headersSent) {
          jsonResponse(response, 500, {
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          });
        }
      }
      return;
    }

    if (url.pathname === '/sse' && request.method === 'GET') {
      const mcpServer = createServer(this.runtime);
      const transport = new SSEServerTransport('/messages', response);
      this.sseSessions.set(transport.sessionId, { server: mcpServer, transport });
      response.on('close', () => {
        this.sseSessions.delete(transport.sessionId);
        void mcpServer.close();
      });
      try {
        await mcpServer.connect(transport);
      } catch (error) {
        this.sseSessions.delete(transport.sessionId);
        if (!response.headersSent) {
          jsonResponse(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return;
    }

    if (url.pathname === '/messages' && request.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const session = this.sseSessions.get(sessionId);
      if (!session) {
        jsonResponse(response, 400, { error: 'Unknown sessionId' });
        return;
      }
      try {
        await session.transport.handlePostMessage(request, response);
      } catch (error) {
        if (!response.headersSent) {
          jsonResponse(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return;
    }

    jsonResponse(response, 404, { error: 'Not Found' });
  }

  /**
   * 多会话路由：
   * - 带 Mcp-Session-Id → 交给对应会话
   * - 未知会话 → 404，客户端重新 initialize 即自动重建
   * - 无会话头 → 只有一个会话时保持兼容，否则新建会话
   */
  private async handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const header = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;

    if (request.method === 'DELETE') {
      if (!sessionId || !this.sessions.has(sessionId)) {
        jsonResponse(response, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }
      const session = this.sessions.get(sessionId)!;
      this.sessions.delete(sessionId);
      if (this.lastSessionId === sessionId) {
        this.lastSessionId = undefined;
      }
      try {
        await session.transport.handleRequest(request, response);
      } catch {
        // 会话关闭失败不影响清理
      }
      try {
        await session.server.close();
      } catch {
        // ignore
      }
      if (!response.headersSent) {
        jsonResponse(response, 200, { ok: true });
      }
      return;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        jsonResponse(response, 404, {
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found. Re-initialize the MCP connection.',
          },
          id: null,
        });
        return;
      }
      await session.transport.handleRequest(request, response);
      return;
    }

    // 没有会话头时，先读 body 区分 initialize 与普通请求。
    // 已读取的 body 通过 SDK 的 parsedBody 参数传入，不能伪造 IncomingMessage。
    let parsedBody: unknown;
    if (request.method === 'POST') {
      const body = await this.readRequestBody(request);
      try {
        parsedBody = body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined;
      } catch {
        jsonResponse(response, 400, {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        });
        return;
      }
    }

    if (request.method === 'POST' && !isInitializeMessage(parsedBody)) {
      // 兼容旧客户端：只有一个会话时复用。
      if (this.sessions.size === 1 && this.lastSessionId) {
        const only = this.sessions.get(this.lastSessionId);
        if (only?.transport.sessionId) {
          request.headers['mcp-session-id'] = only.transport.sessionId;
          await only.transport.handleRequest(request, response, parsedBody);
          return;
        }
      }
      jsonResponse(response, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing Mcp-Session-Id' },
        id: null,
      });
      return;
    }

    if (request.method === 'GET') {
      const only =
        this.sessions.size === 1 && this.lastSessionId
          ? this.sessions.get(this.lastSessionId)
          : undefined;
      if (only?.transport.sessionId) {
        request.headers['mcp-session-id'] = only.transport.sessionId;
        await only.transport.handleRequest(request, response);
        return;
      }
      jsonResponse(response, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing Mcp-Session-Id' },
        id: null,
      });
      return;
    }

    const session = await this.createSession();
    try {
      await session.transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      try {
        await session.server.close();
      } catch {
        // ignore
      }
      throw error;
    }

    const createdId = session.transport.sessionId;
    if (createdId) {
      this.sessions.set(createdId, session);
      this.lastSessionId = createdId;
    } else {
      try {
        await session.server.close();
      } catch {
        // ignore
      }
    }
  }

  private async createSession(): Promise<StreamableSession> {
    const server = createServer(this.runtime);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    transport.onerror = (error) => {
      console.error('[esmith-mcp] transport error:', error);
    };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        this.sessions.delete(id);
        if (this.lastSessionId === id) {
          this.lastSessionId = undefined;
        }
      }
      void server.close().catch(() => undefined);
    };
    await server.connect(transport);
    return { server, transport };
  }

  private readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }
}
