/**
 * Self-Healing 通用引擎。
 *
 * 只负责“失败后是否继续、如何恢复”的决策与预算，不执行具体动作：
 * - RetryBudget：flash / verify 各自独立的重试预算
 * - RecoveryPolicy：失败后选择 retry / rewind / abort
 * - AnchorPoint：记录回退锚点，便于结果可解释
 * - guard limit：总尝试次数上限，防止无限循环
 */

export type HealingStage = 'build' | 'flash' | 'verify';

export interface AnchorPoint {
  stage: HealingStage;
  attempt: number;
  action: string;
  reason: string;
  at: number;
}

export type HealingEventType = 'attempt' | 'retry' | 'rewind' | 'anchor' | 'exhausted';

export interface HealingEvent {
  type: HealingEventType;
  stage: HealingStage;
  attempt: number;
  action: string;
  reason?: string;
}

export type RecoveryKind = 'retry' | 'rewind' | 'abort';

export interface RecoveryDecision {
  kind: RecoveryKind;
  stage: HealingStage;
  action: string;
  reason: string;
}

export interface HealingSnapshot {
  totalAttempts: number;
  recoveries: number;
  exhausted: boolean;
  budgets: Record<'flash' | 'verify', { max: number; used: number }>;
  rewinds: { max: number; used: number };
  anchors: AnchorPoint[];
}

export interface SelfHealingOptions {
  flashRetries: number;
  verifyRetries: number;
  rewinds?: number;
  maxTotalAttempts?: number;
  onEvent?: (event: HealingEvent) => void;
  now?: () => number;
}

export class SelfHealingController {
  private readonly budgets: Record<'flash' | 'verify', { max: number; used: number }>;
  private readonly rewinds: { max: number; used: number };
  private readonly maxTotalAttempts: number;
  private readonly onEvent?: (event: HealingEvent) => void;
  private readonly now: () => number;
  private totalAttempts = 0;
  private recoveries = 0;
  private exhausted = false;
  private readonly anchors: AnchorPoint[] = [];

  constructor(options: SelfHealingOptions) {
    this.budgets = {
      flash: { max: Math.max(0, options.flashRetries), used: 0 },
      verify: { max: Math.max(0, options.verifyRetries), used: 0 },
    };
    this.rewinds = { max: Math.max(0, options.rewinds ?? 0), used: 0 };
    this.maxTotalAttempts = Math.max(
      3,
      options.maxTotalAttempts ??
        (this.budgets.flash.max + 1) * 2 + (this.budgets.verify.max + 1) * 2 + this.rewinds.max * 2
    );
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => Date.now());
  }

  canAttempt(stage: 'flash' | 'verify'): boolean {
    if (this.exhausted || this.totalAttempts >= this.maxTotalAttempts) {
      return false;
    }
    return this.budgets[stage].used < this.budgets[stage].max + 1;
  }

  /**
   * 开始一次尝试，返回 1 基序号；预算或 guard limit 用尽时返回 undefined。
   */
  beginAttempt(stage: 'flash' | 'verify'): number | undefined {
    if (!this.canAttempt(stage)) {
      return undefined;
    }
    this.budgets[stage].used += 1;
    this.totalAttempts += 1;
    const attempt = this.budgets[stage].used;
    this.emit({
      type: 'attempt',
      stage,
      attempt,
      action: `第 ${attempt} 次 ${stage}`,
    });
    return attempt;
  }

  succeed(stage: 'build' | 'flash' | 'verify', attempt = 1): void {
    this.emit({ type: 'anchor', stage, attempt, action: '成功锚点' });
    this.anchors.push({
      stage,
      attempt,
      action: 'success',
      reason: `${stage} 成功`,
      at: this.now(),
    });
  }

  /**
   * 记录一次失败并给出恢复决策。
   * allowRewind=false 时跳过“重新烧录”回退，直接进入停止。
   */
  fail(
    stage: HealingStage,
    reason: string,
    options: { allowRewind?: boolean } = {}
  ): RecoveryDecision {
    if (stage === 'build') {
      this.exhausted = true;
      this.emit({ type: 'exhausted', stage, attempt: 0, action: '停止', reason });
      return { kind: 'abort', stage, action: '停止', reason };
    }

    const attempt = this.budgets[stage].used;
    this.anchors.push({ stage, attempt, action: 'failure', reason, at: this.now() });
    const guardExhausted = this.totalAttempts >= this.maxTotalAttempts;

    if (!guardExhausted && this.budgets[stage].used < this.budgets[stage].max + 1) {
      this.recoveries += 1;
      this.emit({ type: 'retry', stage, attempt, action: '复位并重试', reason });
      return { kind: 'retry', stage, action: '复位并重试', reason };
    }

    if (
      !guardExhausted &&
      stage === 'verify' &&
      options.allowRewind !== false &&
      this.rewinds.used < this.rewinds.max
    ) {
      this.rewinds.used += 1;
      this.recoveries += 1;
      this.emit({ type: 'rewind', stage, attempt, action: '重新烧录', reason });
      return { kind: 'rewind', stage, action: '重新烧录', reason };
    }

    this.exhausted = true;
    this.emit({ type: 'exhausted', stage, attempt, action: '停止', reason });
    return { kind: 'abort', stage, action: '停止', reason };
  }

  /**
   * 回到烧录锚点：重置 flash / verify 的已用预算，但保留总尝试次数。
   */
  rewind(): void {
    this.budgets.flash.used = 0;
    this.budgets.verify.used = 0;
  }

  snapshot(): HealingSnapshot {
    return {
      totalAttempts: this.totalAttempts,
      recoveries: this.recoveries,
      exhausted: this.exhausted,
      // max 对外表示“总尝试次数”（重试次数 + 1），避免 used=3/max=2 被误读为越界。
      budgets: {
        flash: {
          max: this.budgets.flash.max + 1,
          used: this.budgets.flash.used,
        },
        verify: {
          max: this.budgets.verify.max + 1,
          used: this.budgets.verify.used,
        },
      },
      rewinds: { ...this.rewinds },
      anchors: [...this.anchors],
    };
  }

  private emit(event: HealingEvent): void {
    this.onEvent?.(event);
  }
}
