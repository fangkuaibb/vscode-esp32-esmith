import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { idfConfig, projectFolder } from '../config';
import { repairGdbinitRomElfPaths } from '../core/gdbinit';
import {
  cleanupOpenOcd,
  findListenPid,
  isOpenOcdProcess,
  isPortOpen,
} from '../core/openocd';
import { resolveUsbJtagLocation } from '../core/openocdDevice';
import { adapterSpeedKhz, applyOpenOcdLocation } from '../core/openocdLaunch';
import { autoFixOpenOcdTapId } from '../core/openocdTapHost';
import { detectTarget, getArtifacts } from '../core/project';
import * as T from './types';

/**
 * 基于 VS Code Debug API 的调试服务。
 *
 * 不自行启动 GDB/OpenOCD：
 * - vscode.debug.startDebugging 启动官方 ESP-IDF 扩展的 gdbtarget 会话
 * - 官方扩展的 DebugConfigurationProvider 负责填充 GDB、ELF 并启动 OpenOCD
 * - 通过 DebugSession.customRequest 发送 DAP 请求完成断点、栈、变量、内存等操作
 */

const DEBUG_SESSION_NAME = 'ESmith Debug';
const COREDUMP_SESSION_NAME = 'ESmith Core Dump';
const DEFAULT_GDB_PORT = 3333;
/** USB-JTAG 链路异常：提示用户重插并降低 adapter speed。 */
const TRANSPORT_WARNING_PATTERN =
  /IN buffer overflow|missing data from bitq|JTAG scan chain interrogation failed|esp_usb_jtag:.*(?:overflow|error)/i;

type DapBreakpoint = {
  id?: number;
  verified?: boolean;
  line?: number;
  source?: { path?: string };
  message?: string;
};

type DapStackFrame = {
  id: number;
  name: string;
  line?: number;
  source?: { path?: string };
  instructionPointerReference?: string;
};

type TrackedBreakpoint = T.DebugBreakpoint & {
  kind: 'source' | 'function' | 'instruction' | 'data';
  sourcePath?: string;
  functionName?: string;
  address?: string;
  dataId?: string;
  logMessageText?: string;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function splitConfigs(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export class DebugService implements vscode.Disposable {
  private session?: vscode.DebugSession;
  private running = false;
  private haltOnEntry = true;
  private gdbPort = DEFAULT_GDB_PORT;
  private stopReason?: string;
  private stopDescription?: string;
  private stopThreadId?: number;
  private stopCounter = 0;
  private orphanOpenOcdCandidate = false;
  private readonly consoleTail: string[] = [];
  private readonly warnings: string[] = [];
  private readonly breakpoints = new Map<string, TrackedBreakpoint>();
  private readonly watchpoints = new Map<string, T.DebugWatchpoint>();
  private lastWatchpointHit?: T.WatchpointHit;
  private watchpointSeq = 0;
  private stopWaiters: Array<() => void> = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly output: vscode.OutputChannel
  ) {
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (this.session?.id === session.id) {
          this.session = undefined;
          this.running = false;
          this.stopReason = 'terminated';
        }
      })
    );
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('gdbtarget', {
        createDebugAdapterTracker: (session) => {
          if (!this.isEsmithSession(session)) {
            return undefined;
          }
          return {
            onDidSendMessage: (message: unknown) =>
              this.handleDapMessage(session, message as Record<string, any>),
          };
        },
      })
    );
  }

  get active(): boolean {
    return Boolean(this.session && vscode.debug.activeDebugSession?.id === this.session.id);
  }

  async start(options: T.DebugStartOptions): Promise<T.DebugStartResult> {
    if (vscode.debug.activeDebugSession) {
      throw new Error(
        `当前已有调试会话（${vscode.debug.activeDebugSession.name}），请先停止后再启动 ESmith 调试。`
      );
    }
    const target = detectTarget(this.projectRoot);
    if (!target) {
      throw new Error('未检测到 CONFIG_IDF_TARGET，请先选择目标芯片。');
    }

    // OpenOCD 20260304 的 esp32c3.cfg 把 _CPUTAPID 写成了 Xtensa ID，先按
    // 同包 esp-config.json 修正，否则 TAP 校验失败会直接导致 OpenOCD 启不来。
    try {
      const tapFix = autoFixOpenOcdTapId(target);
      if (tapFix?.status === 'fixed') {
        this.output.appendLine(`[debug] 已修正 OpenOCD ${target} IDCODE：${tapFix.message}`);
      } else if (tapFix?.status === 'mismatch') {
        this.output.appendLine(`[debug] OpenOCD ${target} IDCODE 未修正：${tapFix.message}`);
      }
    } catch (error) {
      this.output.appendLine(
        `[debug] OpenOCD IDCODE 检查失败：${asError(error).message}`
      );
    }

    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.projectRoot));
    if (!folder) {
      throw new Error('当前工程不在 VS Code 工作区内。');
    }

    const haltOnEntry = options.haltOnEntry !== false;
    const rawPort = options.port?.trim();
    // port 支持两种含义：COMx / /dev/tty* 作为调试串口；数字作为 GDB server 端口。
    const serialPort =
      rawPort && (/^COM\d+$/i.test(rawPort) || rawPort.startsWith('/dev/'))
        ? rawPort
        : undefined;
    const gdbPort = serialPort ? DEFAULT_GDB_PORT : normalizePort(rawPort);
    let useExternalServer = gdbPort !== DEFAULT_GDB_PORT;

    // 3333 上已经有 OpenOCD 时直接复用（通常是官方 ESP-IDF 扩展或上一次
    // JTAG 操作留下的实例），不要报“端口被占用”，也不要杀掉它。
    if (!useExternalServer && (await isPortOpen(DEFAULT_GDB_PORT))) {
      const pid = await findListenPid(DEFAULT_GDB_PORT);
      if (pid && (await isOpenOcdProcess(pid))) {
        useExternalServer = true;
        this.output.appendLine(
          `[debug] 复用已运行的 OpenOCD（PID ${pid}，GDB ${DEFAULT_GDB_PORT}）`
        );
      } else {
        throw new Error(
          `端口 ${DEFAULT_GDB_PORT} 已被${
            pid ? ` PID ${pid}` : '其它进程'
          }占用，且不是 OpenOCD。请先释放该端口。`
        );
      }
    }

    // 官方插件选中的 COM 口决定了用户想用哪块板。解析成 OpenOCD 的 USB 位置，
    // 避免多块同 VID/PID 的 USB-JTAG 设备同时在线时抓错板。
    const configuredPort =
      serialPort ?? idfConfig().get<string>('port', '').trim();
    const jtagDevice =
      !useExternalServer && configuredPort
        ? await resolveUsbJtagLocation(configuredPort)
        : undefined;
    if (!useExternalServer && configuredPort) {
      this.output.appendLine(
        jtagDevice
          ? `[debug] 使用 USB-JTAG 位置 ${jtagDevice.location}（${configuredPort}${
              jtagDevice.usbSerial ? `，serial ${jtagDevice.usbSerial}` : ''
            }）`
          : `[debug] 未能从 ${configuredPort} 解析 USB-JTAG 位置，OpenOCD 将按 VID/PID 选择设备`
      );
    }

    const adapterSpeed = adapterSpeedKhz();
    if (!useExternalServer && adapterSpeed) {
      this.output.appendLine(`[debug] adapter speed ${adapterSpeed} kHz`);
    }

    const buildDir = idfConfig().get<string>('buildPath', 'build');
    const elf = options.elfPath?.trim()
      ? path.resolve(this.projectRoot, options.elfPath.trim())
      : getArtifacts(this.projectRoot, buildDir).elf;
    // 官方扩展在 ELF 缺失时仍会启动 gdbtarget（launch 配置没有 program），
    // 会话一直等不到 app_main，最终把 MCP 调用拖到超时。启动前直接给出明确错误。
    if (!elf || !fs.existsSync(elf)) {
      const buildPath = path.resolve(this.projectRoot, buildDir);
      // 官方日志里可能有上一次操作的无关错误（例如 esptool 连接超时），
      // 只保留与 ELF 相关的行，避免误导。
      const officialTail = this.officialLogTail()
        .split(/\r?\n/)
        .filter((line) => /ELF/i.test(line))
        .join('\n');
      throw new Error(
        `Project ELF not found in ${buildPath}. Build the project first.` +
          (officialTail ? `\n官方日志：\n${officialTail}` : '')
      );
    }

    // 官方扩展每次构建都会重新生成 build/gdbinit/symbols，且可能缺少版本目录分隔符。
    // 在启动调试前就地修正，避免 add-symbol-file 失败导致 gdbserver 停止。
    const repaired = repairGdbinitRomElfPaths(
      path.resolve(this.projectRoot, buildDir)
    );
    if (repaired.length > 0) {
      this.output.appendLine(
        `[debug] 已修正 gdbinit ROM ELF 路径：${repaired.join(', ')}`
      );
    }

    const connectCommands = haltOnEntry
      ? [
          'set remotetimeout 20',
          `target remote localhost:${gdbPort}`,
          'monitor reset halt',
          'maintenance flush register-cache',
        ]
      : [
          'set remotetimeout 20',
          `target remote localhost:${gdbPort}`,
          'monitor reset run',
          'maintenance flush register-cache',
        ];

    // 不能同时提供 target.parameters 和 connectCommands 里的 target remote：
    // 适配器会建立两次 GDB 连接，OpenOCD 只允许一个，第二次会被拒绝。
    const configuration: vscode.DebugConfiguration = {
      type: 'gdbtarget',
      request: 'attach',
      name: DEBUG_SESSION_NAME,
      runOpenOCD: !useExternalServer,
      initialBreakpoint: haltOnEntry ? 'app_main' : '',
      target: {
        connectCommands,
        ...(serialPort ? { uart: { serialPort, baudRate: 115200 } } : {}),
      },
      ...(elf ? { program: elf } : {}),
      ...(options.gdbCommands?.length ? { initCommands: options.gdbCommands } : {}),
    };

    this.output.appendLine(
      `[debug] 启动 gdbtarget 会话（${target}，GDB ${gdbPort}${
        useExternalServer ? '，复用已有 OpenOCD' : '，由官方扩展启动 OpenOCD'
      }）`
    );
    this.output.appendLine(`[debug] launch=${JSON.stringify(configuration)}`);
    this.orphanOpenOcdCandidate = !useExternalServer;

    const stopCounterBeforeStart = this.stopCounter;
    try {
      await this.withOpenOcdConfig(options.openocdCfg, async () => {
        // 必须在 openOcdConfigs 已确定之后再生成 launch args，
        // 否则 openocdCfg 覆盖会被非空的 launch args 绕过。
        const restoreLocation = await applyOpenOcdLocation({
          location: jtagDevice?.location,
          adapterSpeedKhz: adapterSpeed,
        });
        try {
          const started = await vscode.debug.startDebugging(folder, configuration);
          if (!started) {
            await delay(800);
            const officialTail = this.officialLogTail();
            throw new Error(
              `VS Code 未能启动 gdbtarget 调试会话。${this.consoleSuffix()}${
                officialTail ? ` 官方日志：${officialTail}` : ''
              }`
            );
          }
        } finally {
          await restoreLocation();
        }
      });
      this.orphanOpenOcdCandidate = false;
    } catch (error) {
      this.output.appendLine(
        `[debug] 启动失败：${asError(error).message}${this.consoleSuffix()}`
      );
      await this.cleanupOrphanOpenOcd();
      throw error;
    }

    const activeSession = vscode.debug.activeDebugSession as
      | vscode.DebugSession
      | undefined;
    if (!activeSession || !this.isEsmithSession(activeSession)) {
      throw new Error('调试会话已启动，但无法获取活动会话。');
    }
    const session: vscode.DebugSession = activeSession;
    this.session = session;
    this.running = !haltOnEntry;
    this.haltOnEntry = haltOnEntry;
    this.stopReason = undefined;
    this.stopDescription = undefined;
    this.stopThreadId = undefined;
    this.breakpoints.clear();
    this.watchpoints.clear();
    this.lastWatchpointHit = undefined;
    this.consoleTail.length = 0;
    this.warnings.length = 0;

    // stopped 事件可能已经在 startDebugging 返回前到达；用计数器判断是否还需要等待。
    if (haltOnEntry && this.stopCounter === stopCounterBeforeStart) {
      this.running = true;
      try {
        await this.waitForStop(15000);
      } catch (error) {
        const message = `调试会话已启动，但 15s 内未停在 app_main：${asError(
          error
        ).message}`;
        this.consoleTail.push(`[warn] ${message}`);
        this.output.appendLine(`[debug] ${message}`);
        await Promise.resolve(vscode.debug.stopDebugging(session)).catch(
          () => undefined
        );
        this.session = undefined;
        this.running = false;
        throw new Error(`${message}${this.consoleSuffix()}`);
      }
    }
    this.gdbPort = gdbPort;

    if (!haltOnEntry && !this.running) {
      await this.request('continue', {
        threadId: await this.resolveThreadId().catch(() => 1),
      }).catch(() => undefined);
    }

    return {
      success: true,
      message: `调试会话已启动（${target}，GDB ${gdbPort}）`,
      sessionId: session.id,
      sessionName: session.name,
      target,
      elf,
      gdbPort,
      haltOnEntry,
      stop: this.running ? undefined : await this.currentStop(),
      console: this.consoleTail.slice(-80),
    };
  }

  async stop(): Promise<T.DebugStopResult> {
    const session =
      this.session ??
      (vscode.debug.activeDebugSession && this.isEsmithSession(vscode.debug.activeDebugSession)
        ? vscode.debug.activeDebugSession
        : undefined);
    if (!session) {
      if (this.orphanOpenOcdCandidate) {
        await this.cleanupOrphanOpenOcd();
        return { success: true, message: '已尝试清理残留的 OpenOCD' };
      }
      return { success: true, message: '当前没有 ESmith 调试会话' };
    }
    try {
      await vscode.debug.stopDebugging(session);
    } catch (error) {
      throw asError(error);
    }
    await delay(300);
    if (this.session?.id === session.id) {
      this.session = undefined;
    }
    this.running = false;
    this.breakpoints.clear();
    this.releaseStopWaiters();
    return { success: true, message: '调试会话已停止' };
  }

  async state(): Promise<T.DebugState> {
    if (!this.session || !this.active) {
      return {
        success: true,
        active: false,
        running: false,
        breakpoints: [...this.breakpoints.values()],
        gdbConsole: this.consoleTail.slice(-80),
        warnings: this.warnings.slice(-10),
      };
    }
    return {
      success: true,
      active: true,
      target: detectTarget(this.projectRoot),
      gdbPort: this.gdbPort,
      haltOnEntry: this.haltOnEntry,
      running: this.running,
      stop: this.running ? { running: true, breakpointIds: [] } : await this.currentStop(),
      breakpoints: [...this.breakpoints.values()],
      gdbConsole: this.consoleTail.slice(-80),
      warnings: this.warnings.slice(-10),
    };
  }

  async setBreakpoint(options: T.BreakpointSetOptions): Promise<T.BreakpointSetResult> {
    this.requireSession();
    const location = options.location?.trim();
    if (!location) {
      throw new Error('location 不能为空');
    }

    let tracked: TrackedBreakpoint;
    if (/^0x[0-9a-fA-F]+$/.test(location)) {
      const existing = [...this.breakpoints.values()].filter(
        (item) => item.kind === 'instruction'
      );
      const response = await this.request('setInstructionBreakpoints', {
        breakpoints: [
          ...existing.map((item) => ({
            instructionReference: item.address,
            condition: item.condition,
            hitCondition: item.hitCount ? String(item.hitCount) : undefined,
          })),
          {
            instructionReference: location,
            condition: options.condition,
            hitCondition:
              options.hitCount !== undefined ? String(options.hitCount) : undefined,
          },
        ],
      });
      const dap = pickBreakpoint(response, existing.length);
      tracked = {
        ...toBreakpoint(dap, `addr:${location}`),
        kind: 'instruction',
        address: location,
      };
    } else {
      const fileMatch = /^(.+):(\d+)$/.exec(location);
      if (fileMatch) {
        const sourcePath = resolveSourcePath(this.projectRoot, fileMatch[1]);
        const line = Number(fileMatch[2]);
        const existing = [...this.breakpoints.values()].filter(
          (item) => item.kind === 'source' && item.sourcePath === sourcePath
        );
        const response = await this.request('setBreakpoints', {
          source: { path: sourcePath },
          sourceModified: false,
          breakpoints: [
            ...existing.map((item) => ({
              line: item.line,
              condition: item.condition,
              hitCondition: item.hitCount ? String(item.hitCount) : undefined,
              logMessage: item.logMessageText,
            })),
            {
              line,
              condition: options.condition,
              hitCondition:
                options.hitCount !== undefined ? String(options.hitCount) : undefined,
              logMessage: options.logMessage,
            },
          ],
        });
        const dap = pickBreakpoint(response, existing.length);
        tracked = {
          ...toBreakpoint(dap, `src:${sourcePath}:${line}`),
          kind: 'source',
          sourcePath,
          line,
        };
      } else {
        const existing = [...this.breakpoints.values()].filter(
          (item) => item.kind === 'function'
        );
        const response = await this.request('setFunctionBreakpoints', {
          breakpoints: [
            ...existing.map((item) => ({
              name: item.functionName,
              condition: item.condition,
              hitCondition: item.hitCount ? String(item.hitCount) : undefined,
            })),
            {
              name: location,
              condition: options.condition,
              hitCondition:
                options.hitCount !== undefined ? String(options.hitCount) : undefined,
            },
          ],
        });
        const dap = pickBreakpoint(response, existing.length);
        tracked = {
          ...toBreakpoint(dap, `fn:${location}`),
          kind: 'function',
          functionName: location,
        };
      }
    }

    tracked.condition = options.condition;
    tracked.hitCount = options.hitCount;
    tracked.logMessage = Boolean(options.logMessage);
    tracked.logMessageText = options.logMessage;
    tracked.enabled = !options.disabled;
    this.breakpoints.set(tracked.id, tracked);
    return {
      success: true,
      message: `已设置断点 ${tracked.id}`,
      breakpoint: tracked,
    };
  }

  async clearBreakpoint(options: {
    id?: string;
    all?: boolean;
  }): Promise<T.BreakpointClearResult> {
    this.requireSession();
    if (options.all) {
      const sources = new Set(
        [...this.breakpoints.values()]
          .filter((item) => item.kind === 'source' && item.sourcePath)
          .map((item) => item.sourcePath as string)
      );
      for (const sourcePath of sources) {
        await this.request('setBreakpoints', {
          source: { path: sourcePath },
          sourceModified: false,
          breakpoints: [],
        });
      }
      await this.request('setFunctionBreakpoints', { breakpoints: [] }).catch(() => undefined);
      await this.request('setInstructionBreakpoints', { breakpoints: [] }).catch(
        () => undefined
      );
      await this.request('setDataBreakpoints', { breakpoints: [] }).catch(() => undefined);
      const cleared = this.breakpoints.size;
      this.breakpoints.clear();
      return { success: true, message: `已清除全部断点（${cleared}）`, cleared };
    }

    const id = options.id?.trim();
    if (!id) {
      throw new Error('请提供 id，或设置 all=true 清除全部断点。');
    }
    const target = this.breakpoints.get(id);
    if (!target) {
      return { success: true, message: `断点 ${id} 不在 ESmith 记录中`, cleared: 0 };
    }
    this.breakpoints.delete(id);

    if (target.kind === 'source' && target.sourcePath) {
      const remaining = [...this.breakpoints.values()].filter(
        (item) => item.kind === 'source' && item.sourcePath === target.sourcePath
      );
      await this.request('setBreakpoints', {
        source: { path: target.sourcePath },
        sourceModified: false,
        breakpoints: remaining.map((item) => ({
          line: item.line,
          condition: item.condition,
          hitCondition: item.hitCount ? String(item.hitCount) : undefined,
          logMessage: item.logMessageText,
        })),
      });
    } else if (target.kind === 'function') {
      const remaining = [...this.breakpoints.values()].filter(
        (item) => item.kind === 'function'
      );
      await this.request('setFunctionBreakpoints', {
        breakpoints: remaining.map((item) => ({
          name: item.functionName,
          condition: item.condition,
          hitCondition: item.hitCount ? String(item.hitCount) : undefined,
        })),
      });
    } else if (target.kind === 'instruction') {
      const remaining = [...this.breakpoints.values()].filter(
        (item) => item.kind === 'instruction'
      );
      await this.request('setInstructionBreakpoints', {
        breakpoints: remaining.map((item) => ({
          instructionReference: item.address,
          condition: item.condition,
          hitCondition: item.hitCount ? String(item.hitCount) : undefined,
        })),
      });
    } else {
      const remaining = [...this.breakpoints.values()].filter(
        (item) => item.kind === 'data'
      );
      await this.request('setDataBreakpoints', {
        breakpoints: remaining.map((item) => ({
          dataId: item.dataId,
          accessType: 'write',
        })),
      });
    }
    return { success: true, message: `已删除断点 ${id}`, cleared: 1 };
  }

  async listBreakpoints(): Promise<T.BreakpointListResult> {
    this.requireSession();
    return { success: true, breakpoints: [...this.breakpoints.values()] };
  }

  async control(action: T.DebugControlAction): Promise<T.DebugControlResult> {
    this.requireSession();
    const threadId = await this.resolveThreadId().catch(() => 1);
    try {
      switch (action) {
        case 'continue':
          await this.request('continue', { threadId });
          this.running = true;
          return { success: true, action, running: true, message: '已继续运行' };
        case 'pause':
          await this.request('pause', { threadId });
          await this.waitForStop(10000).catch(() => undefined);
          return {
            success: true,
            action,
            running: false,
            message: '已暂停',
            stop: await this.currentStop(),
          };
        case 'step_over':
        case 'step_in':
        case 'step_out': {
          this.running = true;
          const command =
            action === 'step_over' ? 'next' : action === 'step_in' ? 'stepIn' : 'stepOut';
          await this.request(command, { threadId });
          await this.waitForStop(15000);
          return {
            success: true,
            action,
            running: false,
            message: '单步完成',
            stop: await this.currentStop(),
          };
        }
        case 'reset': {
          // 通过 REPL 通道执行，适配器会把 monitor 命令转给 GDB。
          await this.repl('monitor reset halt');
          await delay(300);
          this.running = false;
          return {
            success: true,
            action,
            running: false,
            message: '设备已复位并暂停',
            stop: await this.currentStop(),
          };
        }
        case 'reset_run': {
          await this.repl('monitor reset run');
          await delay(200);
          this.running = true;
          return {
            success: true,
            action,
            running: true,
            message: '设备已复位并继续运行',
          };
        }
        case 'reset_to_app': {
          await this.repl('monitor reset halt');
          await this.repl('tbreak app_main');
          await this.request('continue', { threadId });
          this.running = true;
          await this.waitForStop(20000).catch(() => undefined);
          this.running = false;
          return {
            success: true,
            action,
            running: false,
            message: '设备已复位并停在 app_main',
            stop: await this.currentStop(),
          };
        }
        default:
          throw new Error(`未知调试动作：${String(action)}`);
      }
    } catch (error) {
      this.running = false;
      throw asError(error);
    }
  }

  async backtrace(options: {
    depth?: number;
    thread?: string;
  }): Promise<T.BacktraceResult> {
    this.requireSession();
    const threadId = await this.resolveThreadId(options.thread);
    const depth = Math.max(1, Math.min(options.depth ?? 20, 100));
    const response = await this.request('stackTrace', {
      threadId,
      startFrame: 0,
      levels: depth,
    });
    const frames = ((response?.stackFrames ?? []) as DapStackFrame[]).map(
      (frame, index) => ({
        level: index,
        func: frame.name,
        file: frame.source?.path,
        line: frame.line,
        addr: frame.instructionPointerReference,
      })
    );
    return { success: true, threadId: String(threadId), frames };
  }

  async listThreads(): Promise<T.ThreadListResult> {
    this.requireSession();
    const response = await this.request('threads');
    const threads = (
      (response?.threads ?? []) as Array<{ id?: number | string; name?: string }>
    ).map((thread) => ({
      id: String(thread.id ?? ''),
      name: thread.name ? String(thread.name) : undefined,
    }));
    return { success: true, threads };
  }

  async registers(filter?: string, thread?: string): Promise<T.RegistersResult> {
    this.requireSession();
    const threadId = await this.resolveThreadId(thread).catch(() => 1);
    const frame = await this.topFrame(threadId).catch(() => undefined);
    if (frame) {
      try {
        const scopes = await this.request('scopes', { frameId: frame.id });
        const registerScope = (scopes?.scopes ?? []).find((scope: { name?: string }) =>
          /register/i.test(String(scope.name ?? ''))
        );
        if (registerScope) {
          const variables = await this.request('variables', {
            variablesReference: registerScope.variablesReference,
          });
          const registers: T.RegisterValue[] = [];
          (variables?.variables ?? []).forEach(
            (variable: { name?: string; value?: string }, index: number) => {
              const name = String(variable.name ?? '');
              if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
                return;
              }
              registers.push({
                number: index,
                name,
                value: String(variable.value ?? ''),
              });
            }
          );
          if (registers.length > 0) {
            return { success: true, registers };
          }
        }
      } catch {
        // 适配器没有 Registers scope 时回退到 evaluate
      }
    }

    const target = detectTarget(this.projectRoot) ?? '';
    const names = registerNames(target);
    const registers: T.RegisterValue[] = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
        continue;
      }
      try {
        const result = await this.request('evaluate', {
          expression: `$${name}`,
          frameId: frame?.id,
          context: 'watch',
        });
        registers.push({
          number: index,
          name,
          value: String(result?.result ?? ''),
        });
      } catch {
        // 某些寄存器名称在当前架构不存在
      }
    }
    return { success: true, registers };
  }

  async readVariable(options: {
    expression: string;
    frame?: number;
  }): Promise<T.VariableResult> {
    this.requireSession();
    const expression = options.expression?.trim();
    if (!expression) {
      throw new Error('expression 不能为空');
    }
    const frameId = await this.resolveFrameId(options.frame).catch(() => undefined);
    const result = await this.request('evaluate', {
      expression,
      frameId,
      context: 'watch',
    });
    return {
      success: true,
      expression,
      value: String(result?.result ?? ''),
    };
  }

  async readMemory(options: {
    address: string;
    length: number;
  }): Promise<T.MemoryReadResult> {
    this.requireSession();
    const address = normalizeAddress(options.address);
    const length = Math.max(1, Math.min(Math.floor(options.length), 65536));
    const response = await this.request('readMemory', {
      memoryReference: address,
      offset: 0,
      count: length,
    });
    const data = Buffer.from(String(response?.data ?? ''), 'base64');
    let ascii = '';
    for (const byte of data) {
      ascii += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
    }
    return {
      success: true,
      address,
      length: data.length,
      hex: data.toString('hex'),
      ascii,
    };
  }

  async writeMemory(options: {
    address: string;
    data: string;
  }): Promise<T.MemoryWriteResult> {
    this.requireSession();
    const address = normalizeAddress(options.address);
    const raw = options.data ?? '';
    const hex = /^([0-9a-fA-F]{2})+$/.test(raw)
      ? raw
      : Buffer.from(raw, 'utf8').toString('hex');
    const response = await this.request('writeMemory', {
      memoryReference: address,
      offset: 0,
      data: Buffer.from(hex, 'hex').toString('base64'),
    });
    return {
      success: true,
      address,
      bytes: Number(response?.bytesWritten ?? hex.length / 2),
      message: `已写入 ${hex.length / 2} 字节`,
    };
  }

  async setWatchpoint(options: T.WatchpointSetOptions): Promise<T.WatchpointSetResult> {
    this.requireSession();
    const expression =
      options.expression?.trim() ||
      (options.address?.trim()
        ? `*(volatile unsigned int*)${normalizeAddress(options.address)}`
        : '');
    if (!expression) {
      throw new Error('请提供 expression 或 address。');
    }
    const command =
      options.mode === 'read' ? 'rwatch' : options.mode === 'access' ? 'awatch' : 'watch';
    const output = await this.repl(`${command} ${expression}`);
    const text = output.join('\n');
    const number = parseWatchpointNumber(text);
    if (
      number === undefined &&
      /no symbol|cannot access memory|syntax error|^error/i.test(text.trim())
    ) {
      throw new Error(`设置监视点失败：${text.trim() || '未知错误'}`);
    }
    const id = number !== undefined ? `wp-${number}` : `wp-${++this.watchpointSeq}`;
    const watchpoint: T.DebugWatchpoint = {
      id,
      number,
      expression,
      mode: options.mode,
    };
    this.watchpoints.set(id, watchpoint);
    return {
      success: true,
      message: `已设置监视点 ${id}（${options.mode}，${expression}）${
        number !== undefined ? `，GDB watchpoint ${number}` : ''
      }`,
      watchpoint,
      output,
    };
  }

  async listWatchpoints(): Promise<T.WatchpointListResult> {
    this.inferWatchpointStop();
    return {
      success: true,
      watchpoints: [...this.watchpoints.values()],
      lastStopReason: this.stopReason,
      lastStopDescription: this.stopDescription,
      lastHit: this.lastWatchpointHit,
    };
  }

  async clearWatchpoint(options: {
    id?: string;
    all?: boolean;
  }): Promise<T.WatchpointClearResult> {
    this.requireSession();
    const watched = [...this.watchpoints.values()];
    const targets = options.all
      ? watched
      : watched.filter(
          (item) =>
            item.id === options.id ||
            (item.number !== undefined && String(item.number) === options.id)
        );
    if (targets.length === 0) {
      throw new Error(`未找到监视点：${options.id ?? '(all)'}`);
    }
    let cleared = 0;
    for (const item of targets) {
      if (item.number !== undefined) {
        await this.repl(`delete ${item.number}`).catch(() => undefined);
      }
      if (this.watchpoints.delete(item.id)) {
        cleared += 1;
      }
    }
    if (this.watchpoints.size === 0) {
      this.lastWatchpointHit = undefined;
    }
    return { success: true, message: `已清除 ${cleared} 个监视点`, cleared };
  }

  async rawCommand(options: T.GdbCommandOptions): Promise<T.GdbCommandResult> {
    this.requireSession();
    const command = options.command?.trim();
    if (!command) {
      throw new Error('command 不能为空');
    }
    const wasRunning = this.running;
    const output = await this.repl(command);
    return {
      success: true,
      output: output.length > 0 ? output : ['(无输出)'],
      ...(wasRunning ? { paused: true } : {}),
    };
  }

  async analyzeCoreDump(options: {
    corePath: string;
    elfPath?: string;
    target?: string;
  }): Promise<T.CoredumpResult> {
    if (vscode.debug.activeDebugSession) {
      throw new Error('请先停止当前调试会话，再分析 core dump。');
    }
    if (!fs.existsSync(options.corePath)) {
      throw new Error(`core 文件不存在：${options.corePath}`);
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.projectRoot));
    if (!folder) {
      throw new Error('当前工程不在 VS Code 工作区内。');
    }
    const buildDir = idfConfig().get<string>('buildPath', 'build');
    const elf = options.elfPath?.trim() || getArtifacts(this.projectRoot, buildDir).elf;
    if (!elf || !fs.existsSync(elf)) {
      throw new Error('未找到 ELF 文件，请先编译或传入 elf_path。');
    }

    // 与官方扩展的 core dump 调试保持一致：使用保留 sessionID，不启动 OpenOCD。
    const started = await vscode.debug.startDebugging(folder, {
      type: 'gdbtarget',
      request: 'attach',
      name: COREDUMP_SESSION_NAME,
      sessionID: 'core-dump.debug.session.ws',
      runOpenOCD: false,
      program: elf,
      target: {
        connectCommands: [`core ${options.corePath.replace(/\\/g, '/')}`],
      },
    });
    if (!started) {
      throw new Error('VS Code 未能启动 core dump 调试会话。');
    }
    const session = vscode.debug.activeDebugSession as
      | vscode.DebugSession
      | undefined;
    if (!session) {
      throw new Error('core dump 会话已启动，但无法获取活动会话。');
    }

    try {
      const threadResponse = await session.customRequest('threads');
      const threads: T.CoredumpThread[] = [];
      for (const thread of threadResponse?.threads ?? []) {
        const frames: string[] = [];
        try {
          const stack = await session.customRequest('stackTrace', {
            threadId: thread.id,
            startFrame: 0,
            levels: 50,
          });
          (stack?.stackFrames ?? []).forEach(
            (frame: DapStackFrame, index: number) => {
              const location = frame.source?.path
                ? `${frame.source.path}:${frame.line ?? '?'}`
                : '?';
              frames.push(`#${index} ${frame.name} at ${location}`);
            }
          );
        } catch (error) {
          frames.push(`[stackTrace 失败] ${asError(error).message}`);
        }
        threads.push({
          id: String(thread.id),
          name: thread.name,
          frames,
        });
      }
      return {
        success: true,
        message: `core 分析完成，共 ${threads.length} 个线程`,
        elf,
        core: options.corePath,
        threads,
        raw: threads.flatMap((thread) => [
          `Thread ${thread.id} (${thread.name ?? 'unknown'}):`,
          ...thread.frames,
        ]),
      };
    } finally {
      await Promise.resolve(vscode.debug.stopDebugging(session)).catch(
        () => undefined
      );
    }
  }

  dispose(): void {
    void this.stop();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private isEsmithSession(session: vscode.DebugSession): boolean {
    return (
      session.name.startsWith(DEBUG_SESSION_NAME) ||
      session.name.startsWith(COREDUMP_SESSION_NAME)
    );
  }

  private handleDapMessage(
    session: vscode.DebugSession,
    message: Record<string, any>
  ): void {
    if (message?.type === 'event') {
      const event = String(message.event ?? '');
      const body = message.body ?? {};
      if (event === 'stopped') {
        this.running = false;
        this.stopCounter += 1;
        this.stopReason = body.reason ? String(body.reason) : undefined;
        this.stopDescription = body.description ? String(body.description) : undefined;
        this.stopThreadId =
          typeof body.threadId === 'number' ? body.threadId : this.stopThreadId;
        this.releaseStopWaiters();
        // gdbtarget 对监视点命中通常只报 generic，真正的信息在 GDB console 里。
        this.inferWatchpointStop();
        if (!this.stopReason || this.stopReason === 'generic') {
          setTimeout(() => this.inferWatchpointStop(), 300);
        }
      } else if (event === 'continued') {
        this.running = true;
      } else if (event === 'terminated') {
        this.running = false;
        this.stopReason = 'terminated';
        if (this.session?.id === session.id) {
          this.session = undefined;
        }
        this.releaseStopWaiters();
      } else if (event === 'output') {
        const text = String(body.output ?? '').replace(/\r?\n$/, '');
        if (text) {
          this.consoleTail.push(text);
          if (this.consoleTail.length > 500) {
            this.consoleTail.splice(0, this.consoleTail.length - 500);
          }
          this.noteDebugWarning(text);
        }
      }
    }
  }

  /**
   * 记录链路/适配器警告，并给出可操作建议。
   */
  private noteDebugWarning(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    let warning: string | undefined;
    if (TRANSPORT_WARNING_PATTERN.test(text)) {
      warning =
        `USB-JTAG 传输异常：${trimmed}。` +
        '建议重插 USB-JTAG，并把 esmith.openocd.adapterSpeed 调低（例如 1000 kHz）后重新 debug_start。';
    } else if (/warning:.*downgraded to software watchpoint/i.test(text)) {
      warning = `适配器警告：${trimmed}。软件监视点会明显拖慢目标；请减少同时设置的 watchpoint，或改用条件断点。`;
    } else if (/^warning:.*(?:jtag|openocd|adapter)/i.test(trimmed)) {
      warning = `适配器警告：${trimmed}`;
    }
    if (!warning || this.warnings.some((item) => item.includes(trimmed))) {
      return;
    }
    this.warnings.push(warning);
    if (this.warnings.length > 20) {
      this.warnings.splice(0, this.warnings.length - 20);
    }
    this.output.appendLine(`[warn] ${warning}`);
  }

  /**
   * DAP 的 stop reason 只有 generic 时，从最近的 GDB console 文本里补全监视点信息。
   */
  private inferWatchpointStop(): void {
    if (this.stopReason && this.stopReason !== 'generic') {
      return;
    }
    const lines = this.consoleTail.slice(-40);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      const match = /hit\s+(?:[Hh]ardware\s+)?[Ww]atchpoint\s+(\d+)\s*:\s*(.+)$/.exec(
        line
      );
      if (!match) {
        continue;
      }
      const number = Number(match[1]);
      const expression = match[2].trim();
      this.stopReason = 'watchpoint';
      this.stopDescription = `Watchpoint ${number}: ${expression}`;
      this.lastWatchpointHit = {
        id: `wp-${number}`,
        number,
        expression,
        description: line,
        at: new Date().toISOString(),
      };
      this.output.appendLine(
        `[debug] 命中监视点 ${number}：${expression}（${line}）`
      );
      return;
    }
  }

  private async withOpenOcdConfig(
    value: string | undefined,
    action: () => Promise<void>
  ): Promise<void> {
    if (!value?.trim()) {
      await action();
      return;
    }
    const configuration = idfConfig();
    const target = projectFolder()
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Workspace;
    const previous = configuration.get<string[]>('openOcdConfigs');
    await configuration.update('openOcdConfigs', splitConfigs(value), target);
    try {
      await action();
    } finally {
      await configuration.update('openOcdConfigs', previous, target);
    }
  }

  private consoleSuffix(): string {
    const lines = this.consoleTail.slice(-6).filter(Boolean);
    return lines.length > 0 ? `\n最近调试输出：\n${lines.join('\n')}` : '';
  }

  private officialLogTail(maxLines = 6): string {
    try {
      const extension = vscode.extensions.getExtension('espressif.esp-idf-extension');
      if (!extension) {
        return '';
      }
      const logPath = path.join(extension.extensionPath, 'esp_idf_vsc_ext.log');
      if (!fs.existsSync(logPath)) {
        return '';
      }
      const stat = fs.statSync(logPath);
      const maxBytes = 64 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      if (length <= 0) {
        return '';
      }
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(logPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
      const lines = buffer
        .toString('utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * 启动失败时清理官方扩展启动的残留 OpenOCD。
   * 只在 ESMith 自己请求了 runOpenOCD 时执行，避免误停用户手动启动的实例。
   */
  private async cleanupOrphanOpenOcd(): Promise<void> {
    if (!this.orphanOpenOcdCandidate) {
      return;
    }
    this.orphanOpenOcdCandidate = false;
    try {
      if (!(await isPortOpen(DEFAULT_GDB_PORT))) {
        this.output.appendLine('[debug] 未发现残留 OpenOCD 端口');
        return;
      }
      const result = await cleanupOpenOcd(DEFAULT_GDB_PORT);
      if (!result.cleaned) {
        this.output.appendLine(
          result.reason === 'not-openocd'
            ? `[debug] 端口 ${DEFAULT_GDB_PORT} 被非 OpenOCD 进程占用，跳过清理`
            : `[debug] 未发现残留 OpenOCD 进程`
        );
        return;
      }
      this.output.appendLine(
        `[debug] 已结束残留 OpenOCD（PID ${result.pid}）`
      );
      await delay(800);
      const stillOpen = await isPortOpen(DEFAULT_GDB_PORT);
      this.output.appendLine(
        `[debug] 清理后端口 ${DEFAULT_GDB_PORT} ${stillOpen ? '仍被占用' : '已释放'}`
      );
    } catch (error) {
      this.output.appendLine(
        `[debug] 清理 OpenOCD 失败：${asError(error).message}`
      );
    }
  }

  private requireSession(): vscode.DebugSession {
    if (!this.session || !this.active) {
      throw new Error('调试会话未启动，请先调用 esmith_debug_start。');
    }
    return this.session;
  }

  private request<T = any>(command: string, args?: unknown): Promise<T> {
    const session = this.requireSession();
    return Promise.resolve(session.customRequest(command, args)) as Promise<T>;
  }

  /**
   * 通过 gdbtarget 的 REPL 通道执行 GDB CLI 命令。
   *
   * 适配器约定：evaluate.expression 以 ">" 开头且 context=repl 时，
   * 会把 ">" 后面的内容交给 `-interpreter-exec console`；输出通过 output 事件返回。
   * 以 ">-" 开头则直接当 MI 命令发送。
   */
  private async repl(command: string): Promise<string[]> {
    const session = this.requireSession();
    const commandText = command.trim().replace(/^>\s*/, '');
    if (!commandText) {
      throw new Error('GDB 命令不能为空。');
    }
    if (this.running) {
      const threadId = await this.resolveThreadId().catch(() => 1);
      await this.request('pause', { threadId }).catch(() => undefined);
      await this.waitForStop(5000).catch(() => undefined);
    }
    const frameId = await this.resolveFrameId().catch(() => undefined);
    if (frameId === undefined) {
      throw new Error(
        '执行 GDB 命令前目标需要处于暂停状态，且当前没有可用栈帧。请先调用 esmith_debug_control { action: "pause" }。'
      );
    }
    const marker = this.consoleTail.length;
    try {
      const response = await session.customRequest('evaluate', {
        expression: `>${commandText}`,
        frameId,
        context: 'repl',
      });
      // 正常情况下输出走 output 事件；个别命令可能只在 evaluate 结果里返回。
      const resultText = String(response?.result ?? '')
        .replace(/\r/g, '')
        .trim();
      if (resultText && resultText !== '') {
        this.consoleTail.push(resultText);
      }
    } catch (error) {
      throw new Error(
        `GDB 命令执行失败：${commandText}（${asError(error).message}）`
      );
    }
    // GDB 的 console 输出通过 output 事件异步返回，等一小段时间再取。
    await delay(250);
    const output = this.consoleTail
      .slice(marker)
      .flatMap((line) => line.split(/\r?\n/))
      .map((line) => line.replace(/\r/g, '').trim())
      .filter((line) => line.length > 0);
    this.output.appendLine(
      `[gdb] ${commandText}${
        output.length > 0 ? ` → ${output[output.length - 1]}` : ''
      }`
    );
    return output;
  }

  private waitForStop(timeoutMs: number): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.stopWaiters.indexOf(done);
        if (index >= 0) {
          this.stopWaiters.splice(index, 1);
        }
        reject(new Error(`等待调试器停止超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.stopWaiters.push(done);
    });
  }

  private releaseStopWaiters(): void {
    const waiters = this.stopWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async resolveThreadId(explicit?: string): Promise<number> {
    if (explicit && /^\d+$/.test(explicit)) {
      return Number(explicit);
    }
    if (this.stopThreadId !== undefined) {
      return this.stopThreadId;
    }
    const response = await this.request('threads');
    const threads = response?.threads ?? [];
    if (threads.length === 0) {
      throw new Error('调试器没有返回任何线程。');
    }
    return Number(threads[0].id);
  }

  private async topFrame(threadId: number): Promise<DapStackFrame | undefined> {
    const response = await this.request('stackTrace', {
      threadId,
      startFrame: 0,
      levels: 1,
    });
    return (response?.stackFrames ?? [])[0];
  }

  private async resolveFrameId(frame?: number): Promise<number | undefined> {
    const threadId = await this.resolveThreadId().catch(() => 1);
    if (typeof frame !== 'number') {
      return (await this.topFrame(threadId).catch(() => undefined))?.id;
    }
    const response = await this.request('stackTrace', {
      threadId,
      startFrame: 0,
      levels: Math.max(1, Math.floor(frame) + 1),
    });
    const frames = (response?.stackFrames ?? []) as DapStackFrame[];
    return frames[Math.floor(frame)]?.id ?? frames[0]?.id;
  }

  private async currentStop(): Promise<T.DebugStopState> {
    const frame = await this.resolveFrameId(0).catch(() => undefined);
    let debugFrame: T.DebugFrame | undefined;
    if (frame !== undefined) {
      try {
        const threadId = await this.resolveThreadId();
        const response = await this.request('stackTrace', {
          threadId,
          startFrame: 0,
          levels: 1,
        });
        const top = (response?.stackFrames ?? [])[0] as DapStackFrame | undefined;
        if (top) {
          debugFrame = {
            level: 0,
            func: top.name,
            file: top.source?.path,
            line: top.line,
            addr: top.instructionPointerReference,
          };
        }
      } catch {
        // ignore
      }
    }
    return {
      running: false,
      reason: this.stopReason,
      signal: this.stopDescription,
      threadId: this.stopThreadId !== undefined ? String(this.stopThreadId) : undefined,
      frame: debugFrame,
      breakpointIds: [],
    };
  }
}

function pickBreakpoint(response: any, index: number): DapBreakpoint {
  const breakpoints = response?.breakpoints ?? [];
  return breakpoints[index] ?? breakpoints[breakpoints.length - 1] ?? { verified: false };
}

function toBreakpoint(dap: DapBreakpoint, fallbackId: string): T.DebugBreakpoint {
  return {
    id: dap.id !== undefined ? String(dap.id) : fallbackId,
    enabled: true,
    line: dap.line,
    file: dap.source?.path,
  };
}

function resolveSourcePath(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function normalizePort(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_GDB_PORT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`端口无效：${value}`);
  }
  return parsed;
}

function normalizeAddress(value: string): string {
  const text = String(value ?? '').trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) {
    return text.toLowerCase();
  }
  if (/^\d+$/.test(text)) {
    return `0x${Number(text).toString(16)}`;
  }
  throw new Error(`地址格式无效：${value}`);
}

function parseWatchpointNumber(text: string): number | undefined {
  const match = /(?:[Hh]ardware\s+)?[Ww]atchpoint\s+(\d+)\s*:/.exec(text);
  return match ? Number(match[1]) : undefined;
}

function registerNames(target: string): string[] {
  if (target === 'esp32' || target === 'esp32s2' || target === 'esp32s3') {
    return [
      'pc',
      'ps',
      'sp',
      ...Array.from({ length: 16 }, (_, index) => `a${index}`),
    ];
  }
  return [
    'pc',
    'sp',
    'ra',
    'gp',
    'tp',
    ...Array.from({ length: 7 }, (_, index) => `t${index}`),
    ...Array.from({ length: 12 }, (_, index) => `s${index}`),
    ...Array.from({ length: 8 }, (_, index) => `a${index}`),
  ];
}
