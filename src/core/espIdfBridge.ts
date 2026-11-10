import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { freshSetting, idfConfig, projectFolder } from '../config';
import {
  BUILD_CORRUPT_HINT,
  detectCorruptedBuildNinja,
  isNinjaCorruptionError,
} from './buildSanity';
import { CompileDiagnostic, mergeDiagnostics, parseCompileErrors } from './compileErrors';
import {
  classifyFlashOutcome,
  FlashConfidence,
  matchesFlashFailure,
  matchesFlashSuccess,
} from './flashOutcome';
import {
  DEFAULT_OPENOCD_PORT,
  findListenPid,
  isOpenOcdProcess,
  isPortOpen,
} from './openocd';
import { resolveUsbJtagLocation } from './openocdDevice';
import { adapterSpeedKhz, applyOpenOcdLocation } from './openocdLaunch';
import { autoFixOpenOcdTapId } from './openocdTapHost';
import { detectTarget, getArtifacts } from './project';

export interface BuildResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  errors: CompileDiagnostic[];
  outputTail: string[];
  message: string;
}

export type { FlashConfidence } from './flashOutcome';

export interface FlashResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  port: string;
  baud: number;
  flashType: string;
  confidence: FlashConfidence;
  outputTail: string[];
  message: string;
}

export interface SetTargetResult {
  success: boolean;
  message: string;
  outputTail?: string[];
}

const COMMANDS = {
  build: 'espIdf.buildDevice',
  flashDevice: 'espIdf.flashDevice',
  flashUart: 'espIdf.flashUart',
  flashJtag: 'espIdf.jtag_flash',
  flashDfu: 'espIdf.flashDFU',
  monitor: 'espIdf.monitorDevice',
  unitTestBuildFlash: 'espIdf.unitTest.buildFlashUnitTestApp',
  unitTestBuild: 'espIdf.unitTest.buildUnitTestApp',
  unitTestFlash: 'espIdf.unitTest.flashUnitTestApp',
  setTarget: 'espIdf.setTarget',
  fullClean: 'espIdf.fullClean',
  getTarget: 'espIdf.getIDFTarget',
  getProjectName: 'espIdf.getProjectName',
  createIdfTerminal: 'espIdf.createIdfTerminal',
};

const OFFICIAL_OUTPUT_HINT =
  '构建/烧录由官方 ESP-IDF 扩展执行；完整日志请查看 ESP-IDF 输出面板或终端。';

function isEspIdfTask(task: vscode.Task): boolean {
  const definitionType = String(task.definition?.type ?? '').toLowerCase();
  return definitionType === 'esp-idf' || task.name.startsWith('ESP-IDF');
}

class EspIdfTaskTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private started = 0;
  private ended = 0;
  private readonly exitCodes: Array<number | undefined> = [];

  constructor() {
    this.disposables.push(
      vscode.tasks.onDidStartTask((event) => {
        if (isEspIdfTask(event.execution.task)) {
          this.started += 1;
        }
      })
    );
    this.disposables.push(
      vscode.tasks.onDidEndTask((event) => {
        if (isEspIdfTask(event.execution.task)) {
          this.ended += 1;
        }
      })
    );
    this.disposables.push(
      vscode.tasks.onDidEndTaskProcess((event) => {
        if (isEspIdfTask(event.execution.task)) {
          this.exitCodes.push(event.exitCode);
        }
      })
    );
  }

  get startedCount(): number {
    return this.started;
  }

  get endedCount(): number {
    return this.ended;
  }

  get lastExitCode(): number | undefined {
    return this.exitCodes.length > 0
      ? this.exitCodes[this.exitCodes.length - 1]
      : undefined;
  }

  get failedExitCode(): number | undefined {
    return this.exitCodes.find(
      (code): code is number => typeof code === 'number' && code !== 0
    );
  }

  terminateAll(): void {
    for (const execution of vscode.tasks.taskExecutions) {
      if (isEspIdfTask(execution.task)) {
        try {
          execution.terminate();
        } catch {
          // ignore
        }
      }
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function artifactSnapshot(projectRoot: string, buildDir: string): Record<string, number> {
  const artifacts = getArtifacts(projectRoot, buildDir);
  const snapshot: Record<string, number> = {};
  for (const [key, value] of Object.entries(artifacts)) {
    if (!value) {
      continue;
    }
    try {
      snapshot[key] = fs.statSync(value).mtimeMs;
    } catch {
      // ignore
    }
  }
  return snapshot;
}

function artifactsChanged(before: Record<string, number>, after: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) {
      return true;
    }
  }
  return false;
}

function collectProjectDiagnostics(projectRoot: string): CompileDiagnostic[] {
  const root = path.resolve(projectRoot).toLowerCase();
  const result: CompileDiagnostic[] = [];
  const seen = new Set<string>();

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    const filePath = uri.fsPath;
    if (!filePath.toLowerCase().startsWith(root)) {
      continue;
    }
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
        diagnostic.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue;
      }
      if (diagnostic.source === 'esmith') {
        continue;
      }
      const severity =
        diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      const key = `${filePath}|${diagnostic.range.start.line}|${diagnostic.range.start.character}|${diagnostic.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({
        file: filePath,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        severity,
        message: diagnostic.message,
        raw: diagnostic.message,
      });
    }
  }

  return result;
}

function officialLogPath(): string | undefined {
  const extension = vscode.extensions.getExtension('espressif.esp-idf-extension');
  return extension ? path.join(extension.extensionPath, 'esp_idf_vsc_ext.log') : undefined;
}

export interface OfficialLogEntry {
  timestamp?: string;
  level?: string;
  category?: string;
  message?: string;
  knownErrorCode?: string;
  command?: string;
  detail?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function logEntryText(entry: OfficialLogEntry): string {
  return [entry.message, entry.detail, entry.stdout, entry.stderr]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
}

/**
 * 读取官方日志最后若干条，不按时间过滤。
 * 仅在失败且本次时间窗内没有日志时兜底使用，避免成功时混入历史错误。
 */
function readOfficialLogTail(
  logPath: string | undefined,
  maxEntries = 20
): OfficialLogEntry[] {
  if (!logPath) {
    return [];
  }
  try {
    const stat = fs.statSync(logPath);
    const maxBytes = 512 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const entries: OfficialLogEntry[] = [];
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line) as OfficialLogEntry);
      } catch {
        // ignore malformed lines
      }
    }
    return entries.slice(-maxEntries);
  } catch {
    return [];
  }
}

function artifactLines(projectRoot: string, buildDir: string): string[] {
  const artifacts = getArtifacts(projectRoot, buildDir);
  const lines: string[] = [];
  for (const [label, file] of [
    ['ELF', artifacts.elf],
    ['BIN', artifacts.bin],
  ] as const) {
    if (!file) {
      continue;
    }
    try {
      const stat = fs.statSync(file);
      lines.push(
        `${label}: ${file}（${stat.size} bytes，${new Date(stat.mtimeMs).toISOString()}）`
      );
    } catch {
      lines.push(`${label}: ${file}`);
    }
  }
  return lines;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function collectOutputLoggingDirs(root: string, maxDepth = 2): string[] {
  const result: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('output_logging_')) {
        result.push(full);
      } else if (depth < maxDepth) {
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return result;
}

const REUSE_NOISE_PATTERN =
  /OpenOCD server failed to start|attempted ['"]?gdb['"]? connection rejected|gdb.*connection rejected/i;

/** USB-JTAG 链路异常：提示重插并降低 adapter speed。 */
const JTAG_TRANSPORT_ERROR_PATTERN =
  /IN buffer overflow|missing data from bitq|JTAG scan chain interrogation failed/i;

const ENV_LINE_PATTERN =
  /^(?:PATH|SYSTEM_PATH|PYTHONPATH|IDF_[A-Z0-9_]+|ESP_IDF_[A-Z0-9_]+|ESP_ROM_[A-Z0-9_]+|OPENOCD_[A-Z0-9_]+)=/i;

function readTaskOutputTail(file: string, maxLines = 50): string[] {
  try {
    const text = stripAnsi(fs.readFileSync(file, 'utf8'));
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !ENV_LINE_PATTERN.test(trimmed);
      })
      .slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * 官方扩展把构建/烧录日志写入 esp_idf_vsc_ext.log（JSON Lines）。
 * 这里读取本次操作开始后的日志，用于完整输出捕获与失败判定。
 */
function readOfficialLogSince(
  logPath: string | undefined,
  sinceMs: number,
  maxEntries = 200
): OfficialLogEntry[] {
  if (!logPath) {
    return [];
  }
  try {
    const stat = fs.statSync(logPath);
    const maxBytes = 2 * 1024 * 1024;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const entries: OfficialLogEntry[] = [];
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as OfficialLogEntry;
        const timestamp = Date.parse(entry.timestamp ?? '');
        if (!Number.isFinite(timestamp) || timestamp < sinceMs) {
          continue;
        }
        entries.push(entry);
      } catch {
        // ignore malformed lines
      }
    }
    return entries.slice(-maxEntries);
  } catch {
    return [];
  }
}

function isOperationEntry(entry: OfficialLogEntry): boolean {
  const category = String(entry.category ?? '');
  const code = String(entry.knownErrorCode ?? '');
  return (
    /build|flash|task|monitor|openocd|jtag|serial/i.test(category) ||
    /TaskFailed|ChildProcessFailed|IdfTask|Flash|Build/i.test(code)
  );
}

function isOpenOcdEntry(entry: OfficialLogEntry): boolean {
  return /openocd|jtag|esp_usb_jtag/i.test(
    [
      entry.category,
      entry.command,
      entry.message,
      entry.detail,
      entry.knownErrorCode,
      entry.stderr,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function collectBuildErrors(entries: OfficialLogEntry[]): string[] {
  return collectOfficialErrors(entries.filter((entry) => !isOpenOcdEntry(entry)));
}

function collectOfficialErrors(entries: OfficialLogEntry[]): string[] {
  const errors = entries
    .filter((entry) => entry.level === 'error' && isOperationEntry(entry))
    .map((entry) => (logEntryText(entry) || entry.category || 'unknown error').slice(0, 800));
  return Array.from(new Set(errors)).slice(-5);
}

function officialOutputTail(entries: OfficialLogEntry[], limit = 40): string[] {
  const relevant = entries.filter(isOperationEntry);
  const selected = (relevant.length > 0 ? relevant : entries).slice(-limit);
  const lines: string[] = [];
  for (const entry of selected) {
    lines.push(`[${entry.level ?? 'info'}] ${entry.message ?? entry.category ?? ''}`);
    for (const stream of [entry.stderr, entry.stdout]) {
      if (!stream) {
        continue;
      }
      lines.push(
        ...String(stream)
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .slice(-12)
      );
    }
  }
  return lines.filter((line) => line.trim().length > 0).slice(-limit * 2);
}

export class EspIdfBridge {
  private available?: boolean;

  constructor(private readonly logUri?: vscode.Uri) {}

  /**
   * 找到本次操作对应的官方扩展 Task 输出日志（output_logging_.../N-ESP-IDF.log）。
   * 官方扩展不会把成功任务的输出写进 esp_idf_vsc_ext.log，但 Task 输出日志有完整内容。
   */
  private findTaskOutputLog(sinceMs: number): string | undefined {
    const roots = new Set<string>();
    if (this.logUri?.fsPath) {
      const dir = path.dirname(this.logUri.fsPath);
      roots.add(dir);
      roots.add(path.dirname(dir));
    }
    const home = os.homedir();
    if (process.platform === 'win32' && process.env.APPDATA) {
      roots.add(path.join(process.env.APPDATA, vscode.env.appName, 'logs'));
    } else if (process.platform === 'darwin') {
      roots.add(
        path.join(home, 'Library', 'Application Support', vscode.env.appName, 'logs')
      );
    } else {
      roots.add(path.join(home, '.config', vscode.env.appName, 'logs'));
    }

    let best: { file: string; mtimeMs: number } | undefined;
    for (const root of roots) {
      for (const dir of collectOutputLoggingDirs(root)) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (
            !entry.isFile() ||
            !entry.name.endsWith('.log') ||
            !/ESP-IDF/i.test(entry.name)
          ) {
            continue;
          }
          const file = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(file);
            if (stat.mtimeMs < sinceMs - 10_000) {
              continue;
            }
            if (!best || stat.mtimeMs > best.mtimeMs) {
              best = { file, mtimeMs: stat.mtimeMs };
            }
          } catch {
            // ignore
          }
        }
      }
    }
    return best?.file;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) {
      return this.available;
    }
    const extension = vscode.extensions.getExtension('espressif.esp-idf-extension');
    if (!extension) {
      this.available = false;
      return false;
    }
    if (!extension.isActive) {
      try {
        await extension.activate();
      } catch {
        this.available = false;
        return false;
      }
    }
    const commands = await vscode.commands.getCommands(true);
    const hasFlash =
      commands.includes(COMMANDS.flashUart) ||
      commands.includes(COMMANDS.flashDevice) ||
      commands.includes(COMMANDS.flashJtag);
    this.available = commands.includes(COMMANDS.build) && hasFlash;
    return this.available;
  }

  async ensureAvailable(): Promise<void> {
    const extension = vscode.extensions.getExtension('espressif.esp-idf-extension');
    if (!extension) {
      throw new Error('未安装官方 ESP-IDF 扩展 espressif.esp-idf-extension。');
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    const commands = await vscode.commands.getCommands(true);
    const missing = [COMMANDS.build, COMMANDS.setTarget].filter(
      (command) => !commands.includes(command)
    );
    const hasFlash =
      commands.includes(COMMANDS.flashUart) ||
      commands.includes(COMMANDS.flashDevice) ||
      commands.includes(COMMANDS.flashJtag);
    if (!hasFlash) {
      missing.push(`${COMMANDS.flashUart} / ${COMMANDS.flashDevice} / ${COMMANDS.flashJtag}`);
    }
    if (missing.length > 0) {
      this.available = false;
      throw new Error(`官方 ESP-IDF 扩展命令不可用：${missing.join(', ')}`);
    }
    this.available = true;
  }

  async build(
    projectRoot: string,
    options: { buildDir?: string; signal?: AbortSignal } = {}
  ): Promise<BuildResult> {
    await this.ensureAvailable();
    const startedAt = Date.now();
    const buildDir =
      options.buildDir || idfConfig().get<string>('buildPath', 'build');
    const corruptedNinja = detectCorruptedBuildNinja(projectRoot, buildDir);
    if (corruptedNinja) {
      return {
        success: false,
        exitCode: 1,
        durationMs: 0,
        errors: [
          {
            file: corruptedNinja,
            line: 0,
            column: 0,
            severity: 'error',
            message: BUILD_CORRUPT_HINT,
            raw: corruptedNinja,
          },
        ],
        outputTail: [
          OFFICIAL_OUTPUT_HINT,
          `检测到损坏的构建文件：${corruptedNinja}`,
          '该文件由官方 ESP-IDF 扩展的 CMake/Ninja 生成，ESmith 不写入构建文件。',
        ],
        message: BUILD_CORRUPT_HINT,
      };
    }
    const before = artifactSnapshot(projectRoot, buildDir);
    const logPath = officialLogPath();
    const tracker = new EspIdfTaskTracker();
    const abortHandler = () => tracker.terminateAll();
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      await vscode.commands.executeCommand(COMMANDS.build);
      await delay(500);
      const entries = readOfficialLogSince(logPath, startedAt);
      // OpenOCD/JTAG 的 stderr 可能与本轮构建同时间出现，不能算作编译失败。
      const officialErrors = collectBuildErrors(entries);
      const buildEntries = entries.filter((entry) => !isOpenOcdEntry(entry));
      const after = artifactSnapshot(projectRoot, buildDir);
      const changed = artifactsChanged(before, after);
      const hasArtifacts = Object.keys(after).length > 0;
      const started = tracker.startedCount > 0;
      const aborted = options.signal?.aborted ?? false;
      const failedExit = tracker.failedExitCode;
      const lastExit = tracker.lastExitCode;

      const projectDiagnostics = collectProjectDiagnostics(projectRoot);
      const projectErrorCount = projectDiagnostics.filter(
        (item) => item.severity === 'error'
      ).length;
      const taskLogFile = this.findTaskOutputLog(startedAt);
      const taskLogLines = taskLogFile ? readTaskOutputTail(taskLogFile, 400) : [];
      const taskTail = taskLogLines.slice(-50);
      // errors 原本只来自 VS Code Problems（语言服务器），ninja/cmake/链接器错误不会进来。
      // 这里把官方 Task 输出里的诊断也解析出来，避免失败时 errors 为空。
      const logDiagnostics = parseCompileErrors(
        [...taskLogLines, ...officialOutputTail(buildEntries)].join('\n')
      );
      const logError = logDiagnostics.find((item) => item.severity === 'error');
      // 预检没覆盖到（例如 JSON 块写法不同）时，ninja 的解析错误也可以映射到同一处置建议。
      const ninjaCorrupt = logDiagnostics.find(
        (item) =>
          isNinjaCorruptionError(item.message) || isNinjaCorruptionError(item.raw)
      );

      let success = false;
      let message = '';
      if (aborted) {
        message = '构建已取消';
      } else if (projectErrorCount > 0) {
        message = `构建失败（${projectErrorCount} 个错误）`;
      } else if (officialErrors.length > 0) {
        message = `构建失败：${officialErrors[officialErrors.length - 1]}`;
      } else if (ninjaCorrupt) {
        message = `${BUILD_CORRUPT_HINT}（${ninjaCorrupt.message}）`;
      } else if (typeof failedExit === 'number' && failedExit !== 0) {
        message = `构建失败（任务退出码 ${failedExit}）${
          logError ? `：${logError.message}` : ''
        }`;
      } else if (!started) {
        message = '官方 ESP-IDF 扩展没有启动构建任务，请检查环境或先运行 ESMith: 集成体检。';
      } else if (logError && !changed) {
        message = `构建失败：${logError.message}`;
      } else if (changed || hasArtifacts) {
        success = true;
        message = '构建成功';
      } else {
        message = '构建任务已结束，但没有生成构建产物，请查看 ESP-IDF 输出面板。';
      }

      const tailEntries =
        buildEntries.length > 0
          ? buildEntries
          : success
            ? []
            : readOfficialLogTail(logPath);
      const errors = mergeDiagnostics(
        projectDiagnostics,
        success ? [] : logDiagnostics
      );
      const exitCode =
        typeof failedExit === 'number'
          ? failedExit
          : typeof lastExit === 'number'
            ? lastExit
            : success
              ? 0
              : 1;
      return {
        success,
        exitCode,
        durationMs: Date.now() - startedAt,
        errors,
        outputTail: [
          OFFICIAL_OUTPUT_HINT,
          ...artifactLines(projectRoot, buildDir),
          ...(buildEntries.length === 0 && !success
            ? ['官方扩展日志最近条目（可能包含历史操作）：']
            : []),
          ...taskTail,
          ...officialOutputTail(tailEntries),
        ],
        message,
      };
    } finally {
      options.signal?.removeEventListener('abort', abortHandler);
      tracker.dispose();
    }
  }

  async flash(
    projectRoot: string,
    port: string,
    baud: number,
    options: { signal?: AbortSignal } = {}
  ): Promise<FlashResult> {
    await this.ensureAvailable();
    const startedAt = Date.now();
    const flashType = this.getFlashType();

    const isJtag = /jtag|openocd/i.test(flashType);
    let preExistingOpenOcdPid: number | undefined;

    // 3333 上已有 OpenOCD 时复用它（通常来自官方 ESP-IDF 扩展或上一次 JTAG 操作），
    // 不要报“端口被占用”，也不要杀掉它。
    if (isJtag && (await isPortOpen(DEFAULT_OPENOCD_PORT))) {
      const pid = await findListenPid(DEFAULT_OPENOCD_PORT);
      if (pid && (await isOpenOcdProcess(pid))) {
        preExistingOpenOcdPid = pid;
      } else {
        return {
          success: false,
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          port,
          baud,
          flashType,
          confidence: 'unconfirmed',
          outputTail: [
            `端口 ${DEFAULT_OPENOCD_PORT} 已被${
              pid ? ` PID ${pid}` : '其它进程'
            }占用，且不是 OpenOCD`,
          ],
          message:
            `端口 ${DEFAULT_OPENOCD_PORT} 已被${
              pid ? ` PID ${pid}` : '其它进程'
            }占用，且不是 OpenOCD。请先释放该端口再烧录。`,
        };
      }
    }
    const reuseNote = preExistingOpenOcdPid
      ? `复用已运行的 OpenOCD（PID ${preExistingOpenOcdPid}）`
      : undefined;

    // 官方插件选中的 COM 口决定用户想用哪块板。把它解析成 OpenOCD 的 USB 位置，
    // 避免多块同 VID/PID 的 USB-JTAG 设备同时在线时抓错板。
    const jtagLocation = isJtag ? await resolveUsbJtagLocation(port) : undefined;
    const deviceNote = isJtag
      ? jtagLocation
        ? `OpenOCD 使用 USB-JTAG 位置 ${jtagLocation.location}（来自 ${port}）`
        : `未能从 ${port} 解析 USB-JTAG 位置，OpenOCD 将按 VID/PID 选择设备`
      : undefined;
    const speed = isJtag ? adapterSpeedKhz() : undefined;

    await this.applyIdfSettings(port, baud);
    const logPath = officialLogPath();

    // JTAG/OpenOCD 可能带着错误的 target IDCODE 配置（如 esp32c3 的 20260304 包）。
    let tapFixNote: string | undefined;
    if (/jtag|openocd/i.test(flashType)) {
      const target = detectTarget(projectRoot);
      if (target) {
        try {
          const fix = autoFixOpenOcdTapId(target);
          if (fix?.status === 'fixed') {
            const changed = fix.fixes.find((item) => item.changed);
            tapFixNote = `已修正 OpenOCD ${target} IDCODE（${changed?.previous ?? '?'} → ${
              changed?.expected ?? '?'
            }）`;
          } else if (fix?.status === 'mismatch') {
            tapFixNote = `OpenOCD ${target} IDCODE 未修正：${fix.message}`;
          }
        } catch {
          // IDCODE 检查失败不阻断烧录
        }
      }
    }

    const tracker = new EspIdfTaskTracker();
    const abortHandler = () => tracker.terminateAll();
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    let restoreLaunchArgs: () => Promise<void> = async () => undefined;
    try {
      restoreLaunchArgs = await applyOpenOcdLocation({
        location: jtagLocation?.location,
        adapterSpeedKhz: adapterSpeedKhz(),
      });
    } catch {
      // 写入 launch args 失败不阻断烧录
    }

    try {
      const command = await this.resolveFlashCommand(flashType);
      // 部分烧录方式（尤其是 JTAG/OpenOCD）把日志写到终端而不是扩展日志文件，
      // 因此同时捕获命令返回值作为判据。
      const output = await vscode.commands.executeCommand<string | undefined>(command);
      const commandOutput = typeof output === 'string' ? output : '';

      // 不能固定等 500ms：UART 任务和 JTAG/OpenOCD 的实际耗时差异很大。
      // 轮询任务结束或日志完成标记，直到成功/失败/超时。
      let entries: OfficialLogEntry[] = [];
      let verified = matchesFlashSuccess(commandOutput);
      let failedMarker = matchesFlashFailure(commandOutput);
      let taskStarted = false;
      let taskEnded = false;
      const flashDeadline = startedAt + 120000;

      for (;;) {
        if (options.signal?.aborted) {
          break;
        }
        taskStarted = tracker.startedCount > 0;
        taskEnded = taskStarted && tracker.endedCount >= tracker.startedCount;
        entries = readOfficialLogSince(logPath, startedAt);
        const logMessages = entries.map((entry) => logEntryText(entry));
        verified = verified || logMessages.some((line) => matchesFlashSuccess(line));
        failedMarker =
          failedMarker || logMessages.some((line) => matchesFlashFailure(line));
        const loopErrors = preExistingOpenOcdPid
          ? collectOfficialErrors(entries).filter(
              (item) => !REUSE_NOISE_PATTERN.test(item)
            )
          : collectOfficialErrors(entries);
        if (verified || failedMarker || loopErrors.length > 0 || taskEnded) {
          break;
        }
        const elapsed = Date.now() - startedAt;
        if (Date.now() >= flashDeadline) {
          break;
        }
        // 没有任何 VS Code Task 时（JTAG/OpenOCD），最多等 20s 日志标记。
        if (!taskStarted && elapsed > 20000) {
          break;
        }
        await delay(250);
      }

      if (taskEnded && tracker.lastExitCode === undefined) {
        // onDidEndTask 可能略早于 onDidEndTaskProcess，给退出码一点时间。
        await delay(300);
      }

      const aborted = options.signal?.aborted ?? false;
      const started = taskStarted;
      const errors = collectOfficialErrors(entries);
      const taskLogFile = this.findTaskOutputLog(startedAt);
      const taskTail = taskLogFile ? readTaskOutputTail(taskLogFile, 60) : [];
      const taskLogText = taskLogFile
        ? readTaskOutputTail(taskLogFile, 400).join('\n')
        : '';

      // 复用外部 OpenOCD 时，官方扩展仍可能尝试再启动/连接 GDB 并被拒绝。
      // 这条噪声不代表烧录失败；实际结果以 Flashed Successfully / Flash Done 为准。
      const isReuseNoise = (text: string): boolean =>
        Boolean(preExistingOpenOcdPid) && REUSE_NOISE_PATTERN.test(text);
      const filterNoiseLines = (text: string): string[] =>
        text
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0 && !isReuseNoise(line));
      const effectiveErrors = errors.filter((item) => !isReuseNoise(item));
      const effectiveLogMessages = entries
        .flatMap((entry) => logEntryText(entry).split(/\r?\n/))
        .filter((line) => !isReuseNoise(line));
      const effectiveTaskLogText = filterNoiseLines(taskLogText).join('\n');
      const effectiveCommandOutput = filterNoiseLines(commandOutput).join('\n');
      const effectiveTaskTail = taskTail.filter((line) => !isReuseNoise(line));

      const outcome = classifyFlashOutcome({
        flashType,
        aborted,
        errors: effectiveErrors,
        commandOutput: effectiveCommandOutput,
        logMessages: effectiveLogMessages,
        taskStarted: started,
        exitCode: tracker.failedExitCode ?? tracker.lastExitCode,
        taskOutput: effectiveTaskLogText,
      });

      // 与官方扩展共用 OpenOCD：烧录结束后保持运行，后续操作直接复用。
      // 需要释放 3333 时由用户显式运行 "ESmith: 清理残留 OpenOCD（3333）"。
      const keepNote =
        isJtag && outcome.success && !preExistingOpenOcdPid
          ? 'OpenOCD 保持运行，后续操作会复用；需要释放请运行 "ESmith: 清理残留 OpenOCD（3333）"'
          : undefined;

      // USB-JTAG 链路不稳时给出可操作建议，而不是让用户反复重试。
      const transportIssue = [
        effectiveTaskLogText,
        effectiveCommandOutput,
        ...effectiveErrors,
      ].find((text) => JTAG_TRANSPORT_ERROR_PATTERN.test(text));
      const transportNote = transportIssue
        ? `检测到 USB-JTAG 传输异常（${transportIssue.trim().slice(0, 120)}）。建议重插 USB-JTAG，并把 esmith.openocd.adapterSpeed 调低（如 1000 kHz）后重试。`
        : undefined;

      const flashBuildDir = idfConfig().get<string>('buildPath', 'build');
      const tailEntries =
        entries.length > 0
          ? entries
          : outcome.success
            ? []
            : readOfficialLogTail(logPath);
      return {
        success: outcome.success,
        exitCode: outcome.success ? 0 : 1,
        durationMs: Date.now() - startedAt,
        port,
        baud,
        flashType,
        confidence: outcome.confidence,
        outputTail: [
          OFFICIAL_OUTPUT_HINT,
          ...(deviceNote ? [deviceNote] : []),
          ...(speed ? [`OpenOCD adapter speed ${speed} kHz（esmith.openocd.adapterSpeed）`] : []),
          ...(reuseNote ? [reuseNote] : []),
          ...(keepNote ? [keepNote] : []),
          ...(transportNote ? [transportNote] : []),
          ...(tapFixNote ? [tapFixNote] : []),
          ...artifactLines(projectRoot, flashBuildDir),
          ...(entries.length === 0 && !outcome.success
            ? ['官方扩展日志最近条目（可能包含历史操作）：']
            : []),
          ...effectiveErrors.slice(-5).map((item) => `[官方错误] ${item}`),
          ...(commandOutput ? filterNoiseLines(commandOutput).slice(-40) : []),
          ...effectiveTaskTail,
          ...officialOutputTail(tailEntries),
        ],
        message: [outcome.message, reuseNote, keepNote, transportNote, tapFixNote]
          .filter((item): item is string => Boolean(item))
          .join('；'),
      };
    } finally {
      options.signal?.removeEventListener('abort', abortHandler);
      tracker.dispose();
      await restoreLaunchArgs();
    }
  }

  getFlashType(): string {
    const value =
      freshSetting<string>('idf', 'flashType')?.value ??
      idfConfig().get<string>('flashType', 'UART');
    return String(value || 'UART').toUpperCase();
  }

  /**
   * 尊重 idf.flashType，不再硬编码 UART。
   * JTAG 优先 jtag_flash，其次 flashDevice；DFU 使用 flashDFU。
   */
  private async resolveFlashCommand(flashType: string): Promise<string> {
    const commands = await vscode.commands.getCommands(true);
    const has = (command: string) => commands.includes(command);
    if (flashType === 'JTAG') {
      if (has(COMMANDS.flashJtag)) {
        return COMMANDS.flashJtag;
      }
      if (has(COMMANDS.flashDevice)) {
        return COMMANDS.flashDevice;
      }
    }
    if (flashType === 'DFU') {
      if (has(COMMANDS.flashDfu)) {
        return COMMANDS.flashDfu;
      }
      if (has(COMMANDS.flashDevice)) {
        return COMMANDS.flashDevice;
      }
    }
    if (has(COMMANDS.flashUart)) {
      return COMMANDS.flashUart;
    }
    if (has(COMMANDS.flashDevice)) {
      return COMMANDS.flashDevice;
    }
    throw new Error('官方 ESP-IDF 扩展没有可用的烧录命令');
  }

  async setTarget(target: string): Promise<SetTargetResult> {
    await this.ensureAvailable();
    try {
      const output = await vscode.commands.executeCommand<string>(
        COMMANDS.setTarget,
        target
      );
      const actual = await this.getTarget();
      const success = actual ? actual.toLowerCase() === target.toLowerCase() : true;
      return {
        success,
        message: success
          ? `目标芯片已切换为 ${target}`
          : `已执行切换，但当前目标仍为 ${actual ?? 'unknown'}`,
        outputTail: typeof output === 'string' ? output.split(/\r?\n/).slice(-100) : undefined,
      };
    } catch (error) {
      return {
        success: false,
        message: `切换目标芯片失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async getTarget(): Promise<string | undefined> {
    try {
      const target = await vscode.commands.executeCommand<string>(COMMANDS.getTarget);
      return typeof target === 'string' && target.trim() ? target.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async getProjectName(): Promise<string | undefined> {
    try {
      const name = await vscode.commands.executeCommand<string>(COMMANDS.getProjectName);
      return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async fullClean(): Promise<void> {
    await this.ensureAvailable();
    await vscode.commands.executeCommand(COMMANDS.fullClean);
  }

  async openIdfTerminal(): Promise<void> {
    await this.ensureAvailable();
    await vscode.commands.executeCommand(COMMANDS.createIdfTerminal);
  }

  async openMonitor(): Promise<boolean> {
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(COMMANDS.monitor)) {
      return false;
    }
    await vscode.commands.executeCommand(COMMANDS.monitor);
    return true;
  }

  async runUnitTest(
    mode: 'build' | 'flash' | 'build-flash'
  ): Promise<{ success: boolean; message: string; outputTail: string[] }> {
    await this.ensureAvailable();
    const commands = await vscode.commands.getCommands(true);
    const command =
      mode === 'build'
        ? COMMANDS.unitTestBuild
        : mode === 'flash'
          ? COMMANDS.unitTestFlash
          : COMMANDS.unitTestBuildFlash;
    if (!commands.includes(command)) {
      return {
        success: false,
        message: `官方 ESP-IDF 扩展未提供 ${command}，请确认扩展版本支持单元测试应用。`,
        outputTail: [],
      };
    }
    const startedAt = Date.now();
    const logPath = officialLogPath();
    try {
      await vscode.commands.executeCommand(command);
      await delay(500);
      const entries = readOfficialLogSince(logPath, startedAt);
      const errors = collectOfficialErrors(entries);
      return {
        success: errors.length === 0,
        message:
          errors.length === 0
            ? `已执行官方单元测试命令（${mode}）`
            : `单元测试命令失败：${errors[errors.length - 1]}`,
        outputTail: officialOutputTail(entries),
      };
    } catch (error) {
      return {
        success: false,
        message: `单元测试命令失败：${error instanceof Error ? error.message : String(error)}`,
        outputTail: [],
      };
    }
  }

  private async applyIdfSettings(port: string, baud: number): Promise<void> {
    const configuration = idfConfig();
    // 多根工作区下必须写到工程文件夹，官方扩展才会在正确的 folder 上读到。
    const target = projectFolder()
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Workspace;
    await configuration.update('port', port, target);
    await configuration.update('flashBaudRate', String(baud), target);
    // 不再强制改写成 UART：烧录方式由 idf.flashType 决定，
    // UART / JTAG / DFU 都由官方扩展执行。
  }
}
