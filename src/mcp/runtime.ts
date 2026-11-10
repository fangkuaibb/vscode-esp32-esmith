import { ClosedLoopOptions, ClosedLoopResult } from '../core/pipeline';
import { InitProjectResult, ProjectTemplate } from '../core/projectInitializer';
import { PortInfo } from '../core/serialService';
import { ExperienceQueryResult, RecordExperienceInput } from '../core/experience';
import * as Debug from '../debug/types';
import { DoctorCheck } from '../env/doctor';
import { IdfInfo } from '../env/idfInfo';

export interface BuildResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  errors: Array<{
    file: string;
    line: number;
    column: number;
    severity: string;
    message: string;
  }>;
  outputTail: string[];
  message: string;
}

export interface FlashResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  port: string;
  baud: number;
  flashType: string;
  confidence: 'verified' | 'task' | 'unconfirmed';
  outputTail: string[];
  message: string;
}

export interface UnitTestResult {
  success: boolean;
  message: string;
  outputTail: string[];
}

export interface MonitorState {
  success: boolean;
  open: boolean;
  port?: string;
  baudRate?: number;
  totalLines: number;
  latestTsMs: number;
}

export interface SerialLinesResult {
  success: boolean;
  lines: Array<{ ts: number; text: string }>;
  totalInBuffer: number;
  latestTsMs: number;
}

export interface EffectiveConfigInfo {
  expectedPattern: string;
  flashBaudRate: number;
  monitorBaudRate: number;
  openOcdConfigs: string[];
  sources: {
    expectedPattern: 'folder' | 'workspace' | 'user' | 'default';
    flashBaudRate: 'folder' | 'workspace' | 'user' | 'default';
    monitorBaudRate: 'folder' | 'workspace' | 'user' | 'default';
    openOcdConfigs: 'folder' | 'workspace' | 'user' | 'default';
  };
}

export interface ProjectInfo {
  success: boolean;
  projectRoot?: string;
  projectName?: string;
  isEspIdfProject?: boolean;
  officialEspIdfAvailable?: boolean;
  idfPath?: string;
  idfVersion?: string;
  idfSource?: string;
  hasMcpSupport?: boolean;
  target?: string;
  port?: string;
  flashType?: string;
  isJtagPort?: boolean;
  monitorOpen: boolean;
  mcpUrl?: string;
  effectiveConfig?: EffectiveConfigInfo;
  doctorFailures?: string[];
}

export interface EsmithRuntime {
  getProjectRoot(): string | undefined;
  getIdfInfo(): IdfInfo | undefined;
  refreshIdfInfo(force?: boolean): Promise<IdfInfo | undefined>;
  getProjectInfo(): Promise<ProjectInfo>;
  initializeProject(options: {
    target?: string;
    template?: ProjectTemplate;
    projectName?: string;
    flashSize?: string;
  }): Promise<InitProjectResult>;
  listPorts(): Promise<PortInfo[]>;
  build(options: { clean?: boolean; timeoutMs?: number }): Promise<BuildResult>;
  flash(options: { port?: string; baud?: number }): Promise<FlashResult>;
  closedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult>;
  monitorStart(port?: string, baud?: number): Promise<MonitorState>;
  monitorStop(): Promise<void>;
  serialTail(lines: number, sinceMs?: number): SerialLinesResult;
  serialSearch(pattern: string, limit: number): SerialLinesResult;
  serialSend(data: string): Promise<void>;
  resetDevice(): Promise<void>;
  stop(): void;
  doctor(): Promise<DoctorCheck[]>;
  setTarget(target: string): Promise<{ success: boolean; message: string; outputTail?: string[] }>;
  getMcpUrl(): string | undefined;
  runUnitTest(mode: 'build' | 'flash' | 'build-flash'): Promise<UnitTestResult>;
  openMonitor(): Promise<boolean>;
  queryExperience(query: string, limit?: number): ExperienceQueryResult;
  recordExperience(input: RecordExperienceInput): { success: boolean; id: string; path: string };

  debugStart(options: Debug.DebugStartOptions): Promise<Debug.DebugStartResult>;
  debugStop(): Promise<Debug.DebugStopResult>;
  debugState(): Promise<Debug.DebugState>;
  debugControl(action: Debug.DebugControlAction): Promise<Debug.DebugControlResult>;
  breakpointSet(options: Debug.BreakpointSetOptions): Promise<Debug.BreakpointSetResult>;
  breakpointClear(options: {
    id?: string;
    all?: boolean;
  }): Promise<Debug.BreakpointClearResult>;
  breakpointList(): Promise<Debug.BreakpointListResult>;
  backtrace(options: {
    depth?: number;
    thread?: string;
  }): Promise<Debug.BacktraceResult>;
  registers(filter?: string, thread?: string): Promise<Debug.RegistersResult>;
  debugThreads(): Promise<Debug.ThreadListResult>;
  readVariable(options: {
    expression: string;
    frame?: number;
  }): Promise<Debug.VariableResult>;
  memoryRead(options: {
    address: string;
    length: number;
  }): Promise<Debug.MemoryReadResult>;
  memoryWrite(options: {
    address: string;
    data: string;
  }): Promise<Debug.MemoryWriteResult>;
  watchpointSet(options: Debug.WatchpointSetOptions): Promise<Debug.WatchpointSetResult>;
  watchpointList(): Promise<Debug.WatchpointListResult>;
  watchpointClear(options: {
    id?: string;
    all?: boolean;
  }): Promise<Debug.WatchpointClearResult>;
  gdbCommand(options: Debug.GdbCommandOptions): Promise<Debug.GdbCommandResult>;
  coredumpAnalyze(options: {
    corePath: string;
    elfPath?: string;
    target?: string;
  }): Promise<Debug.CoredumpResult>;
}
