export interface DebugStartOptions {
  port?: string;
  haltOnEntry?: boolean;
  openocdCfg?: string;
  gdbCommands?: string[];
  elfPath?: string;
}

export interface DebugFrame {
  level: number;
  func?: string;
  file?: string;
  line?: number;
  addr?: string;
  args?: string;
}

export interface DebugStopState {
  running: boolean;
  reason?: string;
  signal?: string;
  threadId?: string;
  frame?: DebugFrame;
  breakpointIds: string[];
}

export interface DebugBreakpoint {
  id: string;
  type?: string;
  enabled: boolean;
  file?: string;
  line?: number;
  func?: string;
  addr?: string;
  condition?: string;
  hitCount?: number;
  logMessage?: boolean;
}

export interface DebugStartResult {
  success: boolean;
  message: string;
  sessionId?: string;
  sessionName?: string;
  target?: string;
  elf?: string;
  gdbPort: number;
  haltOnEntry: boolean;
  stop?: DebugStopState;
  console: string[];
}

export interface DebugStopResult {
  success: boolean;
  message: string;
}

export interface DebugState {
  success: boolean;
  active: boolean;
  target?: string;
  gdbPort?: number;
  haltOnEntry?: boolean;
  running: boolean;
  stop?: DebugStopState;
  breakpoints: DebugBreakpoint[];
  gdbConsole: string[];
  warnings?: string[];
}

export interface BreakpointSetOptions {
  location: string;
  condition?: string;
  hitCount?: number;
  logMessage?: string;
  temporary?: boolean;
  hardware?: boolean;
  disabled?: boolean;
}

export interface BreakpointSetResult {
  success: boolean;
  message: string;
  breakpoint?: DebugBreakpoint;
}

export interface BreakpointListResult {
  success: boolean;
  breakpoints: DebugBreakpoint[];
}

export interface BreakpointClearResult {
  success: boolean;
  message: string;
  cleared: number;
}

export type DebugControlAction =
  | 'continue'
  | 'pause'
  | 'step_over'
  | 'step_in'
  | 'step_out'
  | 'reset'
  | 'reset_run'
  | 'reset_to_app';

export interface DebugControlResult {
  success: boolean;
  action: DebugControlAction;
  running: boolean;
  message: string;
  stop?: DebugStopState;
}

export interface BacktraceResult {
  success: boolean;
  threadId?: string;
  frames: DebugFrame[];
}

export interface RegisterValue {
  number: number;
  name?: string;
  value: string;
}

export interface RegistersResult {
  success: boolean;
  registers: RegisterValue[];
}

export interface VariableResult {
  success: boolean;
  expression: string;
  value: string;
}

export interface MemoryReadResult {
  success: boolean;
  address: string;
  length: number;
  hex: string;
  ascii: string;
}

export interface MemoryWriteResult {
  success: boolean;
  address: string;
  bytes: number;
  message: string;
}

export interface WatchpointSetOptions {
  expression?: string;
  address?: string;
  mode: 'read' | 'write' | 'access';
}

export interface DebugWatchpoint {
  id: string;
  /** GDB watchpoint 编号，用于 delete。 */
  number?: number;
  expression: string;
  mode: 'read' | 'write' | 'access';
}

export interface WatchpointSetResult {
  success: boolean;
  message: string;
  watchpoint?: DebugWatchpoint;
  output?: string[];
}

export interface WatchpointHit {
  id?: string;
  number?: number;
  expression?: string;
  description?: string;
  at: string;
}

export interface WatchpointListResult {
  success: boolean;
  watchpoints: DebugWatchpoint[];
  lastStopReason?: string;
  lastStopDescription?: string;
  lastHit?: WatchpointHit;
}

export interface WatchpointClearResult {
  success: boolean;
  message: string;
  cleared: number;
}

export interface ThreadInfo {
  id: string;
  name?: string;
}

export interface ThreadListResult {
  success: boolean;
  threads: ThreadInfo[];
}

export interface GdbCommandOptions {
  command: string;
  timeoutMs?: number;
}

export interface GdbCommandResult {
  success: boolean;
  output: string[];
  result?: unknown;
  /** 执行命令前是否因为目标正在运行而自动暂停。 */
  paused?: boolean;
}

export interface CoredumpThread {
  id: string;
  name?: string;
  frames: string[];
}

export interface CoredumpResult {
  success: boolean;
  message: string;
  elf: string;
  core: string;
  threads: CoredumpThread[];
  raw: string[];
}
