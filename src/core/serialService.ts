import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { createCrashInfo, CrashInfo, detectCrash, detectCrashInText } from './crashDetector';
import { stripAnsi } from './processRunner';
import { LogLine, RingBuffer } from './ringBuffer';

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  locationId?: string;
  friendlyName: string;
  likelyEsp: boolean;
  isJtag: boolean;
}

export interface SerialSample {
  text: string;
  lines: LogLine[];
  bytes: number;
  matched: boolean;
  crash?: CrashInfo;
}

export interface SerialOpenOptions {
  port: string;
  baudRate: number;
}

type SerialPortInstance = {
  isOpen: boolean;
  open(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  write(data: string | Buffer, callback?: (error?: Error | null) => void): boolean;
  set(
    options: { dtr?: boolean; rts?: boolean; brk?: boolean },
    callback?: (error?: Error | null) => void
  ): void;
  on(event: string, listener: (...args: any[]) => void): void;
  removeAllListeners(): void;
};

type SerialPortConstructor = {
  new (options: Record<string, unknown>): SerialPortInstance;
  list(): Promise<Array<Record<string, string | undefined>>>;
};

let SerialPortClass: SerialPortConstructor | undefined;
let serialLoadError: string | undefined;

try {
  // serialport 是原生模块，必须保持 external，不能在 esbuild 中打包。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const serialport = require('serialport') as { SerialPort?: SerialPortConstructor };
  if (!serialport.SerialPort) {
    throw new Error('serialport.SerialPort 不存在');
  }
  SerialPortClass = serialport.SerialPort;
} catch (error) {
  serialLoadError = error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ESP_VIDS = new Set(['303a', '10c4', '1a86', '0403']);

export async function listSerialPorts(): Promise<PortInfo[]> {
  if (!SerialPortClass) {
    throw new Error(`serialport 不可用：${serialLoadError ?? '未知错误'}`);
  }
  const ports = await SerialPortClass.list();
  return ports.map((port: any) => {
    const vendorId = String(port.vendorId ?? '').toLowerCase();
    const productId = String(port.productId ?? '').toLowerCase();
    const likelyEsp = ESP_VIDS.has(vendorId);
    // ESP32-S3/C3/C6/P4 等内置 USB-JTAG-Serial，VID 303a，PID 1001。
    const isJtag = vendorId === '303a' && productId === '1001';
    const labelParts = [port.path];
    if (isJtag) {
      labelParts.push('USB-JTAG');
    } else if (port.manufacturer) {
      labelParts.push(port.manufacturer);
    } else if (likelyEsp) {
      labelParts.push('ESP 设备');
    }
    return {
      path: String(port.path),
      manufacturer: port.manufacturer ? String(port.manufacturer) : undefined,
      serialNumber: port.serialNumber ? String(port.serialNumber) : undefined,
      vendorId: port.vendorId ? String(port.vendorId) : undefined,
      productId: port.productId ? String(port.productId) : undefined,
      pnpId: port.pnpId ? String(port.pnpId) : undefined,
      locationId: port.locationId ? String(port.locationId) : undefined,
      friendlyName: labelParts.join(' · '),
      likelyEsp,
      isJtag,
    };
  });
}

export class SerialService extends EventEmitter {
  private readonly ring = new RingBuffer(5000);
  private port?: SerialPortInstance;
  private decoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private currentPath = '';
  private currentBaud = 0;
  private recentCrashPatterns: string[] = [];
  private lastCrashSignature = '';
  private lastCrashAt = 0;

  get loadError(): string | undefined {
    return serialLoadError;
  }

  isAvailable(): boolean {
    return Boolean(SerialPortClass);
  }

  get isOpen(): boolean {
    return Boolean(this.port?.isOpen);
  }

  get path(): string {
    return this.currentPath;
  }

  get baudRate(): number {
    return this.currentBaud;
  }

  get lineCount(): number {
    return this.ring.length;
  }

  async listPorts(): Promise<PortInfo[]> {
    return listSerialPorts();
  }

  async open(portPath: string, baudRate: number): Promise<void> {
    if (!SerialPortClass) {
      throw new Error(`serialport 不可用：${serialLoadError ?? '未知错误'}`);
    }
    if (this.port?.isOpen && this.currentPath === portPath && this.currentBaud === baudRate) {
      return;
    }
    await this.close();

    const port = new SerialPortClass({
      path: portPath,
      baudRate,
      autoOpen: false,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      xany: false,
      // 打开串口时不要拉低 DTR（GPIO0），否则设备会停留在下载模式。
      dtr: false,
      rts: false,
    });

    this.port = port;
    this.currentPath = portPath;
    this.currentBaud = baudRate;
    this.decoder = new StringDecoder('utf8');
    this.lineBuffer = '';

    port.on('data', (chunk: Buffer) => this.handleData(chunk));
    port.on('close', () => {
      this.emit('close', { path: portPath });
    });
    port.on('error', (error: Error) => {
      this.emit('portError', error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        port.open((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      this.port = undefined;
      this.currentPath = '';
      this.currentBaud = 0;
      throw new Error(
        `无法打开串口 ${portPath}：${error instanceof Error ? error.message : String(error)}。` +
          '请确认串口未被 ESP-IDF 监视器、另一个 Trae/VS Code 窗口或其它程序占用。'
      );
    }

    this.ring.clear();
    this.emit('open', { path: portPath, baudRate });
  }

  async close(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    this.currentPath = '';
    this.currentBaud = 0;
    if (!port) {
      return;
    }
    try {
      port.removeAllListeners();
    } catch {
      // ignore
    }
    if (port.isOpen) {
      await new Promise<void>((resolve) => {
        try {
          port.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  async reset(): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) {
      throw new Error('串口未打开，无法复位设备');
    }
    const set = (options: { dtr?: boolean; rts?: boolean }) =>
      new Promise<void>((resolve, reject) => {
        port.set(options, (error?: Error | null) => (error ? reject(error) : resolve()));
      });

    // DTR 接 GPIO0，RTS 接 EN：复位期间保持 DTR=false，避免 GPIO0 被拉低
    // 导致设备进入下载模式，只拉低再释放 RTS 完成正常启动复位。
    await set({ dtr: false, rts: false });
    await delay(20);
    await set({ dtr: false, rts: true });
    await delay(150);
    await set({ dtr: false, rts: false });
    await delay(50);
  }

  async resetPort(portPath: string, baudRate: number): Promise<void> {
    const alreadyOpen = this.isOpen && this.currentPath === portPath;
    if (!alreadyOpen) {
      await this.open(portPath, baudRate);
    }
    await this.reset();
    if (!alreadyOpen) {
      await this.close();
    }
  }

  async send(data: string): Promise<void> {
    const port = this.port;
    if (!port?.isOpen) {
      throw new Error('串口未打开');
    }
    const payload = data.endsWith('\n') ? data : `${data}\n`;
    await new Promise<void>((resolve, reject) => {
      port.write(payload, (error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  async waitForOutput(options: {
    sinceTs: number;
    maxMs: number;
    minBytes?: number;
    expectedPattern?: string;
    signal?: AbortSignal;
  }): Promise<SerialSample> {
    const { sinceTs, maxMs, minBytes = 10, expectedPattern = '', signal } = options;
    return new Promise<SerialSample>((resolve, reject) => {
      let settled = false;
      let settleTimer: NodeJS.Timeout | undefined;
      let cleanup: () => void = () => undefined;

      const finish = (matched: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const lines = this.ring.since(sinceTs);
        const text = lines.map((line) => line.text).join('\n');
        const patterns = detectCrashInText(text);
        resolve({
          text,
          lines,
          bytes: Buffer.byteLength(text, 'utf8'),
          matched,
          crash: patterns.length > 0 ? createCrashInfo(patterns, lines.slice(-300)) : undefined,
        });
      };

      const onLine = (line: LogLine) => {
        if (!expectedPattern || settled) {
          return;
        }
        if (line.text.includes(expectedPattern)) {
          // 命中后短暂等待，尽量收齐同一批启动日志。
          settleTimer = setTimeout(() => finish(true), 300);
        }
      };

      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error('串口采样已取消'));
      };

      const timer = setTimeout(() => finish(false), Math.max(100, maxMs));

      cleanup = () => {
        clearTimeout(timer);
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        this.removeListener('line', onLine);
        signal?.removeEventListener('abort', onAbort);
      };

      this.on('line', onLine);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // 如果已经存在足够的数据且没有期望特征，也应至少等到采样窗口结束，
      // 以便捕获慢启动固件；这里不做提前返回。
      void minBytes;
    });
  }

  tail(count: number): LogLine[] {
    return this.ring.tail(count);
  }

  since(timestamp: number): LogLine[] {
    return this.ring.since(timestamp);
  }

  search(pattern: string, limit = 100): LogLine[] {
    return this.ring.search(pattern, limit);
  }

  latestTs(): number {
    return this.ring.latestTs();
  }

  clear(): void {
    this.ring.clear();
  }

  async dispose(): Promise<void> {
    await this.close();
    this.removeAllListeners();
  }

  private handleData(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    this.lineBuffer += text;

    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.lineBuffer);
      if (!match || match.index === undefined) {
        break;
      }
      const rawLine = this.lineBuffer.slice(0, match.index);
      this.lineBuffer = this.lineBuffer.slice(match.index + match[0].length);
      this.handleLine(rawLine);
    }
  }

  private handleLine(rawLine: string): void {
    const line = stripAnsi(rawLine).replace(/\u0000/g, '');
    if (!line.trim()) {
      return;
    }
    const entry = this.ring.push(line);
    this.emit('line', entry);

    const patterns = detectCrash(line);
    if (patterns.length === 0) {
      return;
    }
    this.recentCrashPatterns.push(...patterns);
    if (this.recentCrashPatterns.length > 20) {
      this.recentCrashPatterns = this.recentCrashPatterns.slice(-20);
    }

    const context = this.ring.tail(300);
    const crash = createCrashInfo(this.recentCrashPatterns, context);
    const now = Date.now();
    if (crash.signature === this.lastCrashSignature && now - this.lastCrashAt < 3000) {
      return;
    }
    this.lastCrashSignature = crash.signature;
    this.lastCrashAt = now;
    this.emit('crash', crash);
  }
}
