import { CompileDiagnostic } from './compileErrors';
import { CrashInfo } from './crashDetector';
import { EspIdfBridge, FlashConfidence } from './espIdfBridge';
import { IdfInfo } from '../env/idfInfo';
import { detectTarget, isEspIdfProject } from './project';
import { SerialService } from './serialService';
import { HealingSnapshot, SelfHealingController } from './selfHealing';

export type PipelineStage = 'preflight' | 'build' | 'flash' | 'verify' | 'report';

export interface PipelineConfig {
  buildDir: string;
  monitorBaudRate: number;
  flashBaudRate: number;
  monitorMs: number;
  expectedPattern: string;
  retries: number;
  reflashOnVerifyFailure: boolean;
}

export interface ClosedLoopOptions {
  port?: string;
  expectedPattern?: string;
  monitorMs?: number;
  retries?: number;
  target?: string;
  clean?: boolean;
  keepMonitor?: boolean;
}

export interface PipelineDeps {
  projectRoot: string;
  idfInfo: IdfInfo;
  bridge: EspIdfBridge;
  serial: SerialService;
  config: PipelineConfig;
  onEvent?: (event: PipelineEvent) => void;
  onLog?: (line: string, stream?: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
}

export type PipelineEvent =
  | { type: 'stage'; stage: PipelineStage; attempt: number; message: string }
  | { type: 'recovery'; stage: PipelineStage; action: string; reason: string }
  | { type: 'log'; stage: PipelineStage; line: string };

export interface SerialCrashResult {
  signature: string;
  patterns: string[];
  context: string[];
}

export interface ClosedLoopResult {
  success: boolean;
  stage: PipelineStage;
  attempts: { build: number; flash: number; verify: number };
  durationMs: number;
  target?: string;
  port?: string;
  idfVersion?: string;
  diagnostics: CompileDiagnostic[];
  serial?: {
    tail: string[];
    crash?: SerialCrashResult;
  };
  buildOutputTail: string[];
  flashOutputTail: string[];
  message: string;
  nextActions: string[];
  flashType?: string;
  flashConfidence?: FlashConfidence;
  flashDurationMs?: number;
  flashVerifiedBy?: 'log' | 'task' | 'serial';
  recovery?: HealingSnapshot;
  experienceHints?: string[];
  cancelled?: boolean;
}

class PipelineCancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'PipelineCancelledError';
  }
}

function tailLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-count);
}

function crashResult(crash: CrashInfo | undefined): SerialCrashResult | undefined {
  if (!crash) {
    return undefined;
  }
  return {
    signature: crash.signature,
    patterns: crash.patterns,
    context: crash.context.map((line) => line.text),
  };
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PipelineCancelledError();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClosedLoopPipeline {
  async run(deps: PipelineDeps, options: ClosedLoopOptions = {}): Promise<ClosedLoopResult> {
    const startedAt = Date.now();
    const config = deps.config;
    const retries = Math.max(0, options.retries ?? config.retries);
    const expectedPattern = (options.expectedPattern ?? config.expectedPattern ?? '').trim();
    const monitorMs = Math.max(500, options.monitorMs ?? config.monitorMs);
    const attempts = { build: 0, flash: 0, verify: 0 };

    const emit = (event: PipelineEvent) => {
      deps.onEvent?.(event);
      if (event.type === 'stage') {
        deps.onLog?.(`[${event.stage}] ${event.message}`);
      } else if (event.type === 'recovery') {
        deps.onLog?.(`[recovery] ${event.action}: ${event.reason}`);
      }
    };

    const patternFailureActions = (): string[] => [
      '烧录已成功；本次失败只是 expectedPattern 未匹配，不需要重新烧录。',
      `确认 esmith.expectedPattern 与固件实际输出一致（当前值：${
        expectedPattern || '(未设置)'
      }）。`,
      '如果刚修改配置，请确认文件已保存；ESmith 会在每次操作时重新读取。',
    ];

    // Self-Healing：flash / verify 各自独立的恢复预算与决策。
    const healing = new SelfHealingController({
      flashRetries: retries,
      verifyRetries: retries,
      rewinds: config.reflashOnVerifyFailure ? 1 : 0,
      onEvent: (event) => {
        if (
          event.type === 'retry' ||
          event.type === 'rewind' ||
          event.type === 'exhausted'
        ) {
          emit({
            type: 'recovery',
            stage: event.stage,
            action: event.action,
            reason: event.reason ?? '',
          });
        }
      },
    });

    let target = options.target || detectTarget(deps.projectRoot) || 'unknown';
    let port = options.port?.trim() || '';
    let buildOutputTail: string[] = [];
    let flashOutputTail: string[] = [];
    let diagnostics: CompileDiagnostic[] = [];
    let lastSerialTail: string[] = [];
    let lastCrash: CrashInfo | undefined;
    let currentStage: PipelineStage = 'preflight';
    let flashType = deps.bridge.getFlashType();
    let flashConfidence: FlashConfidence = 'unconfirmed';
    let flashDurationMs: number | undefined;
    let flashVerifiedBy: 'log' | 'task' | 'serial' | undefined;
    let flashSucceeded = false;

    const fail = (
      stage: PipelineStage,
      message: string,
      nextActions: string[]
    ): ClosedLoopResult => ({
      success: false,
      stage,
      attempts,
      durationMs: Date.now() - startedAt,
      target,
      port: port || undefined,
      idfVersion: deps.idfInfo.version,
      diagnostics,
      serial: {
        tail: lastSerialTail,
        crash: crashResult(lastCrash),
      },
      buildOutputTail,
      flashOutputTail,
      message,
      nextActions,
      flashType,
      flashConfidence,
      flashDurationMs,
      flashVerifiedBy,
      recovery: healing.snapshot(),
    });

    try {
      // ── preflight ────────────────────────────────────────────────
      currentStage = 'preflight';
      emit({ type: 'stage', stage: 'preflight', attempt: 1, message: '检查工程、官方 ESP-IDF 扩展、串口与目标芯片' });
      checkAbort(deps.signal);

      if (!isEspIdfProject(deps.projectRoot)) {
        return fail('preflight', '当前目录不是有效的 ESP-IDF 工程', [
          '确认工作区根目录包含 CMakeLists.txt，并且 include 了 project.cmake 或 idf.cmake。',
        ]);
      }
      if (!(await deps.bridge.isAvailable())) {
        return fail('preflight', '官方 ESP-IDF 扩展命令不可用', [
          '安装并激活 espressif.esp-idf-extension，然后在 ESP-IDF 扩展中选择 IDF 版本。',
        ]);
      }
      if (!deps.serial.isAvailable()) {
        return fail('preflight', `串口模块不可用：${deps.serial.loadError ?? '未知错误'}`, [
          '检查 ESmith 扩展安装是否完整，或查看输出面板。',
        ]);
      }

      if (!port) {
        port = await this.resolvePort(deps);
      }
      target = options.target || detectTarget(deps.projectRoot) || 'unknown';

      // ── build ───────────────────────────────────────────────────
      currentStage = 'build';
      attempts.build = 1;
      emit({ type: 'stage', stage: 'build', attempt: 1, message: '开始编译（官方 ESP-IDF 扩展）' });
      if (options.clean) {
        emit({ type: 'stage', stage: 'build', attempt: 1, message: '执行 fullclean' });
        await deps.bridge.fullClean();
      }
      const build = await deps.bridge.build(deps.projectRoot, {
        buildDir: config.buildDir,
        signal: deps.signal,
      });
      buildOutputTail = build.outputTail;
      diagnostics = build.errors;
      checkAbort(deps.signal);
      deps.onLog?.(build.message);
      if (!build.success) {
        const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
        return fail(
          'build',
          build.message,
          errorCount > 0
            ? ['根据 diagnostics 修复编译错误后重新运行闭环。']
            : ['查看 ESP-IDF 输出面板定位构建失败原因后重试。']
        );
      }
      healing.succeed('build', 1);
      emit({ type: 'stage', stage: 'build', attempt: 1, message: '编译成功' });

      // ── flash / verify（Self-Healing 驱动） ─────────────────────
      let nextAction: 'flash' | 'verify' = 'flash';
      let lastVerifyFailure: string | undefined;
      let patternOnlyMismatch = false;

      while (true) {
        checkAbort(deps.signal);

        if (nextAction === 'flash') {
          const flashAttempt = healing.beginAttempt('flash');
          if (flashAttempt === undefined) {
            const decision = healing.fail('flash', lastVerifyFailure ?? '烧录失败');
            return fail('flash', decision.reason, [
              '确认串口未被占用。',
              '尝试把 esmith.flashBaudRate 降到 115200。',
              '确认开发板已连接，且 idf.flashType 与实际烧录方式一致。',
            ]);
          }
          attempts.flash = flashAttempt;
          currentStage = 'flash';
          emit({
            type: 'stage',
            stage: 'flash',
            attempt: flashAttempt,
            message: `烧录到 ${port}（第 ${flashAttempt} 次，方式 ${flashType}）`,
          });

          try {
            await deps.serial.close();
          } catch {
            // ignore
          }

          const flash = await deps.bridge.flash(
            deps.projectRoot,
            port,
            config.flashBaudRate,
            { signal: deps.signal }
          );
          flashOutputTail = flash.outputTail;
          flashType = flash.flashType;
          flashConfidence = flash.confidence;
          flashDurationMs = flash.durationMs;
          flashVerifiedBy =
            flash.confidence === 'verified'
              ? 'log'
              : flash.confidence === 'task'
                ? 'task'
                : undefined;
          checkAbort(deps.signal);
          deps.onLog?.(flash.message);

          if (flash.success) {
            flashSucceeded = true;
            healing.succeed('flash', flashAttempt);
            emit({ type: 'stage', stage: 'flash', attempt: flashAttempt, message: '烧录命令完成' });
            nextAction = 'verify';
            continue;
          }

          lastVerifyFailure = flash.message || '烧录失败';
          const decision = healing.fail('flash', lastVerifyFailure);
          if (decision.kind === 'retry') {
            try {
              await deps.serial.resetPort(port, config.monitorBaudRate);
            } catch {
              // ignore reset errors
            }
            await delay(500);
            continue;
          }
          return fail('flash', lastVerifyFailure, [
            '确认串口未被占用。',
            '检查开发板是否处于下载模式，或改用 idf.flashType 对应的烧录方式。',
          ]);
        }

        // verify
        const verifyAttempt = healing.beginAttempt('verify');
        if (verifyAttempt === undefined) {
          const decision = healing.fail(
            'verify',
            lastVerifyFailure ?? '运行验证失败',
            { allowRewind: !patternOnlyMismatch }
          );
          if (patternOnlyMismatch) {
            return fail(
              'verify',
              lastVerifyFailure ?? '运行验证失败',
              patternFailureActions()
            );
          }
          if (decision.kind === 'rewind') {
            healing.rewind();
            nextAction = 'flash';
            continue;
          }
          return fail('verify', lastVerifyFailure ?? '运行验证失败', [
            '检查串口输出与崩溃日志。',
            '确认 expectedPattern 与实际日志一致。',
            '检查供电、TX/RX 接线、波特率和串口占用。',
          ]);
        }

        attempts.verify = verifyAttempt;
        patternOnlyMismatch = false;
        currentStage = 'verify';
        emit({
          type: 'stage',
          stage: 'verify',
          attempt: verifyAttempt,
          message: `复位并采样串口（第 ${verifyAttempt} 次）`,
        });

        try {
          await deps.serial.open(port, config.monitorBaudRate);
          const since = Date.now();
          await deps.serial.reset();
          const sample = await deps.serial.waitForOutput({
            sinceTs: since,
            maxMs: monitorMs,
            minBytes: 10,
            expectedPattern,
            signal: deps.signal,
          });
          checkAbort(deps.signal);

          lastSerialTail = sample.lines.slice(-300).map((line) => line.text);
          lastCrash = sample.crash;

          if (sample.crash) {
            lastVerifyFailure = `检测到崩溃：${sample.crash.signature}`;
          } else if (sample.bytes < 10) {
            lastVerifyFailure = `串口输出过少（${sample.bytes} 字节），设备可能没有正常启动`;
          } else if (expectedPattern && !sample.text.includes(expectedPattern)) {
            patternOnlyMismatch = true;
            lastVerifyFailure = flashSucceeded
              ? `烧录已成功，但串口验证未匹配 expectedPattern：${expectedPattern}`
              : `串口输出中未找到期望特征：${expectedPattern}`;
          } else {
            healing.succeed('verify', verifyAttempt);
            if (!options.keepMonitor) {
              await deps.serial.close();
            }
            // 串口能启动并输出预期特征，说明镜像已成功写入；用 serial 反证 flash 成功。
            if (flashSucceeded && flashConfidence !== 'verified') {
              flashConfidence = 'verified';
              flashVerifiedBy = 'serial';
            }
            emit({ type: 'stage', stage: 'verify', attempt: verifyAttempt, message: '验证通过' });
            return {
              success: true,
              stage: 'verify',
              attempts,
              durationMs: Date.now() - startedAt,
              target,
              port,
              idfVersion: deps.idfInfo.version,
              diagnostics,
              serial: {
                tail: lastSerialTail,
                crash: crashResult(lastCrash),
              },
              buildOutputTail,
              flashOutputTail,
              message: '闭环验证通过',
              nextActions: [],
              flashType,
              flashConfidence,
              flashDurationMs,
              flashVerifiedBy,
              recovery: healing.snapshot(),
            };
          }
        } catch (error) {
          if (error instanceof PipelineCancelledError) {
            throw error;
          }
          lastVerifyFailure = `串口验证失败：${error instanceof Error ? error.message : String(error)}`;
        }

        const decision = healing.fail(
          'verify',
          lastVerifyFailure ?? '运行验证失败',
          { allowRewind: !patternOnlyMismatch }
        );
        if (decision.kind === 'retry') {
          try {
            await deps.serial.close();
          } catch {
            // ignore
          }
          await delay(300);
          continue;
        }
        if (patternOnlyMismatch) {
          // 烧录已经成功，只是日志特征不匹配；重烧不会改变日志内容。
          return fail(
            'verify',
            lastVerifyFailure ?? '运行验证失败',
            patternFailureActions()
          );
        }
        if (decision.kind === 'rewind') {
          healing.rewind();
          nextAction = 'flash';
          continue;
        }
        return fail('verify', lastVerifyFailure ?? '运行验证失败', [
          '检查串口输出与崩溃日志。',
          '确认 expectedPattern 与实际日志一致。',
          '检查供电、TX/RX 接线、波特率和串口占用。',
        ]);
      }
    } catch (error) {
      if (error instanceof PipelineCancelledError || deps.signal?.aborted) {
        return {
          success: false,
          stage: currentStage,
          attempts,
          durationMs: Date.now() - startedAt,
          target,
          port: port || undefined,
          idfVersion: deps.idfInfo.version,
          diagnostics,
          serial: { tail: lastSerialTail, crash: crashResult(lastCrash) },
          buildOutputTail,
          flashOutputTail,
          message: '任务已取消',
          nextActions: [],
          flashType,
          flashConfidence,
          flashDurationMs,
          flashVerifiedBy,
          recovery: healing.snapshot(),
          cancelled: true,
        };
      }
      return fail(
        currentStage,
        error instanceof Error ? error.message : String(error),
        ['查看 ESmith 输出面板获取详细信息。']
      );
    } finally {
      if (!options.keepMonitor) {
        try {
          await deps.serial.close();
        } catch {
          // ignore
        }
      }
    }
  }

  private async resolvePort(deps: PipelineDeps): Promise<string> {
    const ports = await deps.serial.listPorts();
    const likely = ports.filter((port) => port.likelyEsp);
    if (likely.length === 1) {
      return likely[0].path;
    }
    if (likely.length > 1) {
      throw new Error(
        `检测到多个疑似 ESP 串口：${likely.map((port) => port.path).join(', ')}。请指定 port。`
      );
    }
    if (ports.length === 1) {
      return ports[0].path;
    }
    if (ports.length === 0) {
      throw new Error('未检测到串口，请连接开发板或指定 port。');
    }
    throw new Error(
      `检测到多个串口：${ports.map((port) => port.path).join(', ')}。请指定 port。`
    );
  }
}
