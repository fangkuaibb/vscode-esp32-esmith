import * as path from 'path';
import * as vscode from 'vscode';
import { esmithConfig, freshSetting, idfConfig, projectFolder } from './config';
import { clearIdfInfoCache, resolveIdfInfo } from './env/idfLocator';
import { IdfInfo } from './env/idfInfo';
import { DoctorCheck, runDoctor } from './env/doctor';
import { EspIdfBridge } from './core/espIdfBridge';
import { ClosedLoopOptions, ClosedLoopPipeline, ClosedLoopResult, PipelineConfig } from './core/pipeline';
import { detectProjectName, detectTarget, isEspIdfProject } from './core/project';
import {
  initializeProject as initializeIdfProject,
  InitProjectResult,
  ProjectTemplate,
} from './core/projectInitializer';
import { SerialService } from './core/serialService';
import {
  experienceHints,
  queryExperience as queryExperienceEngine,
  recordExperience as recordExperienceEngine,
  updateRunStats,
  ExperienceQueryResult,
  RecordExperienceInput,
} from './core/experience';
import { LogLine } from './core/ringBuffer';
import { DebugService } from './debug/debugService';
import * as Debug from './debug/types';
import {
  BuildResult,
  EsmithRuntime,
  FlashResult,
  MonitorState,
  ProjectInfo,
  SerialLinesResult,
} from './mcp/runtime';

export class EsmithRuntimeImpl implements EsmithRuntime, vscode.Disposable {
  readonly output: vscode.OutputChannel;
  readonly serialOutput: vscode.OutputChannel;
  readonly serial: SerialService;
  readonly bridge: EspIdfBridge;
  readonly pipeline = new ClosedLoopPipeline();

  private idfInfo?: IdfInfo;
  private mcpUrl?: string;
  private debugService?: DebugService;
  private abortController?: AbortController;
  private activeOperation?: string;
  private debugRoot?: string;
  private lastPort = '';
  private lastTarget = '';
  private readonly stateEmitter = new vscode.EventEmitter<void>();

  private expectedPatternSource(): 'folder' | 'workspace' | 'user' | 'default' {
    return (
      freshSetting<string>('esmith', 'expectedPattern')?.source ??
      this.configSource(esmithConfig(), 'expectedPattern')
    );
  }

  private configSource(
    configuration: vscode.WorkspaceConfiguration,
    key: string
  ): 'folder' | 'workspace' | 'user' | 'default' {
    const inspected = configuration.inspect(key);
    if (!inspected) {
      return 'default';
    }
    if (projectFolder() && inspected.workspaceFolderValue !== undefined) {
      return 'folder';
    }
    if (inspected.workspaceValue !== undefined) {
      return 'workspace';
    }
    if (inspected.globalValue !== undefined) {
      return 'user';
    }
    return 'default';
  }

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.bridge = new EspIdfBridge(context.logUri);
    this.output = vscode.window.createOutputChannel('ESmith');
    this.serialOutput = vscode.window.createOutputChannel('ESmith Serial');
    this.serial = new SerialService();

    // 闭环采样期间把串口日志实时镜像到独立输出面板，便于人机同步观察。
    this.serial.on('line', (entry: LogLine) => {
      const mirror = esmithConfig().get<boolean>('closedLoop.serialMirror', true);
      if (mirror) {
        this.serialOutput.appendLine(entry.text);
      }
    });

    this.serial.on('open', (event: { path: string; baudRate: number }) => {
      this.output.appendLine(`[serial] 已打开 ${event.path} @ ${event.baudRate}`);
      this.stateEmitter.fire();
    });
    this.serial.on('close', () => {
      this.output.appendLine('[serial] 已关闭');
      this.stateEmitter.fire();
    });
    this.serial.on('portError', (error: Error) => {
      this.output.appendLine(`[serial] 错误：${error.message}`);
    });
    this.serial.on('crash', (crash: { signature: string }) => {
      this.output.appendLine(`[serial] 检测到崩溃：${crash.signature}`);
    });
  }

  getProjectRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const idfProject = folders.find((folder) => isEspIdfProject(folder.uri.fsPath));
    return (idfProject ?? folders[0])?.uri.fsPath;
  }

  getIdfInfo(): IdfInfo | undefined {
    return this.idfInfo;
  }

  getMcpUrl(): string | undefined {
    return this.mcpUrl;
  }

  setMcpUrl(url: string | undefined): void {
    this.mcpUrl = url;
    this.stateEmitter.fire();
  }

  refreshProjectState(): void {
    const projectRoot = this.getProjectRoot();
    this.lastTarget = projectRoot ? detectTarget(projectRoot) ?? '' : '';
    this.stateEmitter.fire();
  }

  private resolveBaud(
    key: 'flashBaudRate' | 'monitorBaudRate',
    fallback: number
  ): { value: number; source: 'folder' | 'workspace' | 'user' | 'default' } {
    const esmithConfiguration = esmithConfig();
    const esmithSource = this.configSource(esmithConfiguration, key);
    const toBaud = (value: unknown): number => {
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(numeric) && numeric > 0
        ? Math.floor(numeric)
        : fallback;
    };
    // 直接读磁盘，避免设置文件被外部修改后仍拿到旧快照。
    const freshEsmith = freshSetting<unknown>('esmith', key);
    if (freshEsmith) {
      return { value: toBaud(freshEsmith.value), source: freshEsmith.source };
    }
    const freshIdf = freshSetting<unknown>('idf', key);
    if (freshIdf) {
      return { value: toBaud(freshIdf.value), source: freshIdf.source };
    }
    if (esmithSource !== 'default') {
      return {
        value: toBaud(esmithConfiguration.get<unknown>(key)),
        source: esmithSource,
      };
    }
    // 兼容官方扩展的 idf.flashBaudRate / idf.monitorBaudRate。
    const idfConfiguration = idfConfig();
    const idfSource = this.configSource(idfConfiguration, key);
    if (idfSource !== 'default') {
      return {
        value: toBaud(idfConfiguration.get<unknown>(key)),
        source: idfSource,
      };
    }
    return { value: fallback, source: 'default' };
  }

  getConfig(): PipelineConfig {
    const configuration = esmithConfig();
    const idfConfiguration = idfConfig();
    const flashBaud = this.resolveBaud('flashBaudRate', 460800);
    const monitorBaud = this.resolveBaud('monitorBaudRate', 115200);
    return {
      buildDir:
        freshSetting<string>('idf', 'buildPath')?.value ??
        idfConfiguration.get<string>('buildPath', 'build'),
      monitorBaudRate: monitorBaud.value,
      flashBaudRate: flashBaud.value,
      monitorMs: configuration.get<number>('monitorMs', 5000),
      expectedPattern:
        freshSetting<string>('esmith', 'expectedPattern')?.value ??
        configuration.get<string>('expectedPattern', ''),
      retries: configuration.get<number>('retries', 2),
      reflashOnVerifyFailure: configuration.get<boolean>('reflashOnVerifyFailure', true),
    };
  }

  async refreshIdfInfo(force = false): Promise<IdfInfo | undefined> {
    if (force) {
      clearIdfInfoCache();
    }
    try {
      const info = await resolveIdfInfo({ force });
      this.idfInfo = info;
      // 让官方 ESP-IDF 扩展与 ESmith 使用同一个 IDF 安装。
      const idfConfiguration = idfConfig();
      const currentSetup = idfConfiguration.get<string>('currentSetup', '');
      if (!currentSetup) {
        await idfConfiguration.update(
          'currentSetup',
          info.idfPath,
          vscode.ConfigurationTarget.Workspace
        );
      }
      this.lastTarget = this.getProjectRoot() ? detectTarget(this.getProjectRoot()!) ?? '' : '';
      this.output.appendLine(`[idf] ${info.version} · ${info.idfPath}（${info.source}）`);
      this.stateEmitter.fire();
      return info;
    } catch (error) {
      this.idfInfo = undefined;
      this.output.appendLine(
        `[idf] 无法定位 ESP-IDF：${error instanceof Error ? error.message : String(error)}`
      );
      this.stateEmitter.fire();
      return undefined;
    }
  }

  async getProjectInfo(): Promise<ProjectInfo> {
    const projectRoot = this.getProjectRoot();
    const idfInfo = this.idfInfo ?? (await this.refreshIdfInfo());
    const validProject = projectRoot ? isEspIdfProject(projectRoot) : false;
    const bridgeAvailable = validProject ? await this.bridge.isAvailable() : false;
    const officialTarget = bridgeAvailable ? await this.bridge.getTarget() : undefined;
    const officialName = bridgeAvailable ? await this.bridge.getProjectName() : undefined;
    const port = this.currentPortLabel();
    let isJtagPort: boolean | undefined;
    if (port && this.serial.isAvailable()) {
      try {
        const ports = await this.serial.listPorts();
        isJtagPort = ports.find((item) => item.path === port)?.isJtag;
      } catch {
        isJtagPort = undefined;
      }
    }
    const esmithConfiguration = esmithConfig();
    const idfConfiguration = idfConfig();
    const flashBaud = this.resolveBaud('flashBaudRate', 460800);
    const monitorBaud = this.resolveBaud('monitorBaudRate', 115200);
    const freshPattern = freshSetting<string>('esmith', 'expectedPattern');
    const freshOpenOcd = freshSetting<string[]>('idf', 'openOcdConfigs');
    return {
      success: Boolean(projectRoot && idfInfo && validProject && bridgeAvailable),
      projectRoot,
      projectName: officialName ?? (projectRoot ? detectProjectName(projectRoot) : undefined),
      isEspIdfProject: validProject,
      officialEspIdfAvailable: bridgeAvailable,
      idfPath: idfInfo?.idfPath,
      idfVersion: idfInfo?.version,
      idfSource: idfInfo?.source,
      hasMcpSupport: idfInfo?.hasMcpSupport,
      target:
        officialTarget ??
        (projectRoot ? this.lastTarget || detectTarget(projectRoot) : undefined),
      port,
      flashType: this.bridge.getFlashType(),
      isJtagPort,
      monitorOpen: this.serial.isOpen,
      mcpUrl: this.mcpUrl,
      effectiveConfig: {
        expectedPattern:
          freshPattern?.value ??
          esmithConfiguration.get<string>('expectedPattern', ''),
        flashBaudRate: flashBaud.value,
        monitorBaudRate: monitorBaud.value,
        openOcdConfigs:
          freshOpenOcd?.value ??
          (idfConfiguration.get<string[]>('openOcdConfigs') ?? []),
        sources: {
          expectedPattern:
            freshPattern?.source ??
            this.configSource(esmithConfiguration, 'expectedPattern'),
          flashBaudRate: flashBaud.source,
          monitorBaudRate: monitorBaud.source,
          openOcdConfigs:
            freshOpenOcd?.source ??
            this.configSource(idfConfiguration, 'openOcdConfigs'),
        },
      },
    };
  }

  async listPorts() {
    return this.serial.listPorts();
  }

  async initializeProject(options: {
    projectRoot?: string;
    target?: string;
    template?: ProjectTemplate;
    projectName?: string;
    flashSize?: string;
  }): Promise<InitProjectResult> {
    // 多根工作区下“初始化当前文件夹”可能不是第一个 root，必须使用用户选中的目录。
    const projectRoot = options.projectRoot ?? this.requireProjectRoot();
    if (isEspIdfProject(projectRoot)) {
      throw new Error('当前工作区已经是 ESP-IDF 工程，无需初始化。');
    }
    const info = this.requireIdfInfo();
    const result = initializeIdfProject({
      projectRoot,
      projectName: options.projectName?.trim() || path.basename(projectRoot),
      target: options.target || 'esp32',
      template: options.template || 'blank',
      flashSize: options.flashSize,
      idfPath: info.idfPath,
      idfVersion: info.version,
    });
    this.refreshProjectState();
    this.output.appendLine(
      `[init] 已初始化 ${result.projectName}（${result.target}，${result.template}）`
    );
    for (const created of result.created) {
      this.output.appendLine(`[init] 创建 ${created}`);
    }
    for (const skipped of result.skipped) {
      this.output.appendLine(`[init] 跳过 ${skipped}`);
    }
    return result;
  }

  async build(options: { clean?: boolean; timeoutMs?: number } = {}): Promise<BuildResult> {
    const projectRoot = this.requireIdfProject();
    await this.bridge.ensureAvailable();
    // 官方扩展的 post-build 会用 idf.port 跑 esptool chip_id；端口不存在时会卡到超时。
    const idfPort = String(
      freshSetting<string>('idf', 'port')?.value ?? idfConfig().get<string>('port', '')
    ).trim();
    if (idfPort && idfPort !== 'detect') {
      try {
        await this.assertPortExists(idfPort);
      } catch (error) {
        throw new Error(
          `${
            error instanceof Error ? error.message : String(error)
          } 官方扩展的 post-build 会使用 idf.port；请改为有效串口或清空该设置后再编译。`
        );
      }
    }
    const controller = this.beginOperation('build');
    try {
      this.output.appendLine('[build] 交给官方 ESP-IDF 扩展执行');
      if (options.clean) {
        await this.bridge.fullClean();
      }
      const build = await this.bridge.build(projectRoot, {
        buildDir: this.getConfig().buildDir,
        signal: controller.signal,
      });
      const errors = build.errors.map((item) => ({
        file: item.file,
        line: item.line,
        column: item.column,
        severity: item.severity,
        message: item.message,
      }));
      this.output.appendLine(
        `[build] ${build.success ? '成功' : '失败'}（${build.durationMs}ms）`
      );
      return {
        success: build.success,
        exitCode: build.exitCode,
        durationMs: build.durationMs,
        errors,
        outputTail: build.outputTail,
        message: build.message,
      };
    } finally {
      this.endOperation(controller);
      this.stateEmitter.fire();
    }
  }

  async flash(options: { port?: string; baud?: number } = {}): Promise<FlashResult> {
    if (this.debugService?.active) {
      throw new Error('调试会话进行中，请先调用 esmith_debug_stop 再烧录。');
    }
    const projectRoot = this.requireIdfProject();
    await this.bridge.ensureAvailable();
    const port = await this.resolvePort(options.port);
    const baud = options.baud ?? this.getConfig().flashBaudRate;
    const controller = this.beginOperation('flash');
    try {
      this.output.appendLine(`[flash] 交给官方 ESP-IDF 扩展：${port} @ ${baud}`);
      await this.serial.close();
      const result = await this.bridge.flash(projectRoot, port, baud, {
        signal: controller.signal,
      });
      this.lastPort = port;
      this.output.appendLine(
        `[flash] ${result.success ? '命令完成' : '失败'}（${result.durationMs}ms）`
      );
      return result;
    } finally {
      this.endOperation(controller);
      this.stateEmitter.fire();
    }
  }

  async closedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult> {
    if (this.debugService?.active) {
      throw new Error('调试会话进行中，请先调用 esmith_debug_stop 再执行闭环。');
    }
    const projectRoot = this.requireIdfProject();
    const idfInfo = this.requireIdfInfo();
    await this.bridge.ensureAvailable();
    const port = await this.resolvePort(options.port);
    this.lastPort = port;
    const controller = this.beginOperation('closed-loop');
    try {
      const config = this.getConfig();
      const flashBaud = this.resolveBaud('flashBaudRate', 460800);
      const monitorBaud = this.resolveBaud('monitorBaudRate', 115200);
      this.output.appendLine(
        `[closed-loop] 生效配置：expectedPattern="${
          config.expectedPattern || '(未设置)'
        }"（${this.expectedPatternSource()}）· ` +
          `flashBaudRate=${config.flashBaudRate}（${flashBaud.source}）· ` +
          `monitorBaudRate=${config.monitorBaudRate}（${monitorBaud.source}）`
      );
      this.output.appendLine('[closed-loop] 开始（官方 ESP-IDF 扩展执行构建/烧录）');
      let hintShown = false;
      const result = await this.pipeline.run(
        {
          projectRoot,
          idfInfo,
          bridge: this.bridge,
          serial: this.serial,
          config,
          signal: controller.signal,
          onLog: (line) => this.output.appendLine(line),
          onEvent: (event) => {
            if (
              event.type === 'stage' &&
              event.stage === 'verify' &&
              !hintShown &&
              esmithConfig().get<boolean>('closedLoop.serialHint', true)
            ) {
              hintShown = true;
              this.showSerialHint(port, config.monitorMs);
            }
          },
        },
        { ...options, port }
      );
      if (!result.success && /expectedPattern/i.test(result.message)) {
        result.message += `（expectedPattern 来源：${this.expectedPatternSource()}）`;
      }
      if (result.port) {
        this.lastPort = result.port;
      }
      if (result.target && result.target !== 'unknown') {
        this.lastTarget = result.target;
      }
      this.output.appendLine(
        `[closed-loop] ${result.success ? '通过' : '失败'} · stage=${result.stage} · ${result.durationMs}ms`
      );

      try {
        updateRunStats(projectRoot, result);
      } catch (error) {
        this.output.appendLine(
          `[experience] 统计写入失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!result.success) {
        try {
          const hints = experienceHints(
            projectRoot,
            `${result.stage} ${result.message} ${result.serial?.crash?.signature ?? ''}`
          );
          if (hints.length > 0) {
            return { ...result, experienceHints: hints };
          }
        } catch {
          // 经验读取失败不影响闭环结果
        }
      }

      return result;
    } finally {
      this.endOperation(controller);
      this.stateEmitter.fire();
    }
  }

  async monitorStart(port?: string, baud?: number): Promise<MonitorState> {
    const resolvedPort = await this.resolvePort(port);
    const baudRate = baud ?? this.getConfig().monitorBaudRate;
    await this.serial.open(resolvedPort, baudRate);
    this.lastPort = resolvedPort;
    this.stateEmitter.fire();
    return {
      success: true,
      open: this.serial.isOpen,
      port: resolvedPort,
      baudRate,
      totalLines: this.serial.lineCount,
      latestTsMs: this.serial.latestTs(),
    };
  }

  async monitorStop(): Promise<void> {
    await this.serial.close();
    this.stateEmitter.fire();
  }

  serialTail(lines: number, sinceMs?: number): SerialLinesResult {
    const entries =
      typeof sinceMs === 'number' && sinceMs > 0 ? this.serial.since(sinceMs) : this.serial.tail(lines);
    return {
      success: true,
      lines: entries.map((line) => ({ ts: line.ts, text: line.text })),
      totalInBuffer: this.serial.lineCount,
      latestTsMs: this.serial.latestTs(),
    };
  }

  serialSearch(pattern: string, limit: number): SerialLinesResult {
    const entries = this.serial.search(pattern, limit);
    return {
      success: true,
      lines: entries.map((line) => ({ ts: line.ts, text: line.text })),
      totalInBuffer: this.serial.lineCount,
      latestTsMs: this.serial.latestTs(),
    };
  }

  async serialSend(data: string): Promise<void> {
    await this.serial.send(data);
  }

  async resetDevice(): Promise<void> {
    if (this.serial.isOpen) {
      await this.serial.reset();
      return;
    }
    const port = await this.resolvePort();
    await this.serial.resetPort(port, this.getConfig().monitorBaudRate);
  }

  async debugStart(options: Debug.DebugStartOptions): Promise<Debug.DebugStartResult> {
    this.requireIdfProject();
    if (this.activeOperation) {
      throw new Error(`当前正在执行 ${this.activeOperation}，请先停止后再启动调试。`);
    }
    return this.getDebugService().start(options);
  }

  async debugStop(): Promise<Debug.DebugStopResult> {
    return this.debugService?.stop() ?? { success: true, message: '当前没有 ESmith 调试会话' };
  }

  async debugState(): Promise<Debug.DebugState> {
    if (!this.debugService) {
      return { success: true, active: false, running: false, breakpoints: [], gdbConsole: [] };
    }
    return this.debugService.state();
  }

  async debugControl(action: Debug.DebugControlAction): Promise<Debug.DebugControlResult> {
    return this.getDebugService().control(action);
  }

  async breakpointSet(
    options: Debug.BreakpointSetOptions
  ): Promise<Debug.BreakpointSetResult> {
    return this.getDebugService().setBreakpoint(options);
  }

  async breakpointClear(options: {
    id?: string;
    all?: boolean;
  }): Promise<Debug.BreakpointClearResult> {
    return this.getDebugService().clearBreakpoint(options);
  }

  async breakpointList(): Promise<Debug.BreakpointListResult> {
    return this.getDebugService().listBreakpoints();
  }

  async backtrace(options: {
    depth?: number;
    thread?: string;
  }): Promise<Debug.BacktraceResult> {
    return this.getDebugService().backtrace(options);
  }

  async registers(filter?: string, thread?: string): Promise<Debug.RegistersResult> {
    return this.getDebugService().registers(filter, thread);
  }

  async debugThreads(): Promise<Debug.ThreadListResult> {
    return this.getDebugService().listThreads();
  }

  async readVariable(options: {
    expression: string;
    frame?: number;
  }): Promise<Debug.VariableResult> {
    return this.getDebugService().readVariable(options);
  }

  async memoryRead(options: {
    address: string;
    length: number;
  }): Promise<Debug.MemoryReadResult> {
    return this.getDebugService().readMemory(options);
  }

  async memoryWrite(options: {
    address: string;
    data: string;
  }): Promise<Debug.MemoryWriteResult> {
    return this.getDebugService().writeMemory(options);
  }

  async watchpointSet(
    options: Debug.WatchpointSetOptions
  ): Promise<Debug.WatchpointSetResult> {
    return this.getDebugService().setWatchpoint(options);
  }

  async watchpointList(): Promise<Debug.WatchpointListResult> {
    return this.getDebugService().listWatchpoints();
  }

  async watchpointClear(options: {
    id?: string;
    all?: boolean;
  }): Promise<Debug.WatchpointClearResult> {
    return this.getDebugService().clearWatchpoint(options);
  }

  async gdbCommand(options: Debug.GdbCommandOptions): Promise<Debug.GdbCommandResult> {
    return this.getDebugService().rawCommand(options);
  }

  async coredumpAnalyze(options: {
    corePath: string;
    elfPath?: string;
    target?: string;
  }): Promise<Debug.CoredumpResult> {
    return this.getDebugService().analyzeCoreDump(options);
  }

  async runUnitTest(
    mode: 'build' | 'flash' | 'build-flash'
  ): Promise<{ success: boolean; message: string; outputTail: string[] }> {
    this.requireIdfProject();
    await this.bridge.ensureAvailable();
    const result = await this.bridge.runUnitTest(mode);
    this.output.appendLine(`[unit-test] ${result.message}`);
    return result;
  }

  async openMonitor(): Promise<boolean> {
    return this.bridge.openMonitor();
  }

  queryExperience(query: string, limit = 5): ExperienceQueryResult {
    const projectRoot = this.requireProjectRoot();
    return queryExperienceEngine(projectRoot, query, limit);
  }

  recordExperience(input: RecordExperienceInput): {
    success: boolean;
    id: string;
    path: string;
  } {
    const projectRoot = this.requireProjectRoot();
    const result = recordExperienceEngine(projectRoot, input);
    this.output.appendLine(`[experience] 已记录 ${result.path}`);
    return result;
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = undefined;
  }

  async doctor(): Promise<DoctorCheck[]> {
    if (!this.idfInfo) {
      await this.refreshIdfInfo();
    }
    const projectRoot = this.getProjectRoot();
    const officialEspIdfAvailable =
      projectRoot && isEspIdfProject(projectRoot) ? await this.bridge.isAvailable() : false;
    return runDoctor({
      projectRoot,
      idfInfo: this.idfInfo,
      serial: this.serial,
      mcpUrl: this.mcpUrl,
      officialEspIdfAvailable,
      flashType: this.bridge.getFlashType(),
    });
  }

  async setTarget(target: string): Promise<{ success: boolean; message: string; outputTail?: string[] }> {
    this.requireIdfProject();
    await this.bridge.ensureAvailable();
    const controller = this.beginOperation('set-target');
    try {
      const result = await this.bridge.setTarget(target);
      if (result.success) {
        this.lastTarget = target;
      }
      this.stateEmitter.fire();
      return result;
    } finally {
      this.endOperation(controller);
    }
  }

  currentPortLabel(): string | undefined {
    if (this.serial.isOpen && this.serial.path) {
      return this.serial.path;
    }
    const idfPort = idfConfig().get<string>('port', '').trim();
    if (idfPort && idfPort !== 'detect') {
      return idfPort;
    }
    return this.lastPort || undefined;
  }

  dispose(): void {
    this.stop();
    this.debugService?.dispose();
    this.debugService = undefined;
    void this.serial.dispose();
    this.stateEmitter.dispose();
    this.output.dispose();
    this.serialOutput.dispose();
    void this.context;
  }

  private showSerialHint(port: string, monitorMs: number): void {
    void vscode.window
      .showInformationMessage(
        `ESmith 正在采样串口 ${port}（${monitorMs}ms），可在 “ESmith Serial” 输出面板同步观察。`,
        '查看实时串口输出',
        '打开 ESP-IDF 监视器'
      )
      .then(async (action) => {
        if (action === '查看实时串口输出') {
          this.serialOutput.show(true);
        } else if (action === '打开 ESP-IDF 监视器') {
          const opened = await this.openMonitor();
          if (!opened) {
            void vscode.window.showWarningMessage(
              '官方 ESP-IDF 扩展未提供 monitorDevice 命令。'
            );
          }
        }
      });
  }

  private requireProjectRoot(): string {
    const projectRoot = this.getProjectRoot();
    if (!projectRoot) {
      throw new Error('当前没有打开工作区');
    }
    return projectRoot;
  }

  private requireIdfProject(): string {
    const projectRoot = this.requireProjectRoot();
    if (!isEspIdfProject(projectRoot)) {
      throw new Error(
        '当前工作区不是 ESP-IDF 工程：根目录 CMakeLists.txt 中没有 project.cmake / idf.cmake。'
      );
    }
    return projectRoot;
  }

  private requireIdfInfo(): IdfInfo {
    if (!this.idfInfo) {
      throw new Error('ESP-IDF 信息尚未就绪，请先运行 ESMith: 集成体检。');
    }
    return this.idfInfo;
  }

  private beginOperation(name: string): AbortController {
    if (this.debugService?.active) {
      throw new Error('调试会话进行中，请先调用 esmith_debug_stop 停止调试。');
    }
    this.stop();
    const controller = new AbortController();
    this.abortController = controller;
    this.activeOperation = name;
    this.output.appendLine(`[${name}] 开始`);
    return controller;
  }

  private endOperation(controller: AbortController): void {
    if (this.abortController === controller) {
      this.abortController = undefined;
      this.activeOperation = undefined;
    }
  }

  private getDebugService(): DebugService {
    const projectRoot = this.requireProjectRoot();
    if (!this.debugService || this.debugRoot !== projectRoot) {
      this.debugService?.dispose();
      this.debugService = new DebugService(projectRoot, this.output);
      this.debugRoot = projectRoot;
    }
    return this.debugService;
  }

  private async assertPortExists(port: string): Promise<void> {
    if (!this.serial.isAvailable()) {
      return;
    }
    let ports;
    try {
      ports = await this.serial.listPorts();
    } catch {
      return; // serialport 不可用时交给官方扩展报错
    }
    if (ports.length === 0) {
      return;
    }
    if (!ports.some((item) => item.path.toLowerCase() === port.toLowerCase())) {
      throw new Error(
        `串口 ${port} 不存在。可用串口：${ports.map((item) => item.path).join(', ')}。`
      );
    }
  }

  private async resolvePort(preferred?: string): Promise<string> {
    const explicit = (preferred ?? '').trim();
    if (explicit) {
      await this.assertPortExists(explicit);
      this.lastPort = explicit;
      return explicit;
    }
    // 串口选择以官方 ESP-IDF 扩展为准。
    const idfPort = String(
      freshSetting<string>('idf', 'port')?.value ?? idfConfig().get<string>('port', '')
    ).trim();
    if (idfPort && idfPort !== 'detect') {
      await this.assertPortExists(idfPort);
      this.lastPort = idfPort;
      return idfPort;
    }
    if (this.lastPort) {
      return this.lastPort;
    }
    const ports = await this.serial.listPorts();
    const likely = ports.filter((port) => port.likelyEsp);
    if (likely.length === 1) {
      this.lastPort = likely[0].path;
      return likely[0].path;
    }
    if (likely.length > 1) {
      throw new Error(
        `检测到多个疑似 ESP 串口：${likely.map((port) => port.path).join(', ')}，请先选择串口。`
      );
    }
    if (ports.length === 1) {
      this.lastPort = ports[0].path;
      return ports[0].path;
    }
    if (ports.length === 0) {
      throw new Error('未检测到串口，请连接开发板或设置 esmith.port。');
    }
    throw new Error(`检测到多个串口：${ports.map((port) => port.path).join(', ')}，请先选择串口。`);
  }
}
