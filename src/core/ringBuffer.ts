export interface LogLine {
  ts: number;
  text: string;
}

export class RingBuffer {
  private lines: LogLine[] = [];

  constructor(private readonly maxLines = 5000) {}

  push(text: string): LogLine {
    const entry: LogLine = { ts: Date.now(), text };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    return entry;
  }

  tail(count: number): LogLine[] {
    return this.lines.slice(Math.max(0, this.lines.length - count));
  }

  since(timestamp: number): LogLine[] {
    return this.lines.filter((line) => line.ts > timestamp);
  }

  search(pattern: string, limit = 100): LogLine[] {
    let expression: RegExp;
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const lastSlash = pattern.lastIndexOf('/');
      const body = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      expression = new RegExp(body, flags);
    } else {
      expression = new RegExp(pattern);
    }
    return this.lines.filter((line) => expression.test(line.text)).slice(-Math.max(1, limit));
  }

  get length(): number {
    return this.lines.length;
  }

  latestTs(): number {
    return this.lines.length > 0 ? this.lines[this.lines.length - 1].ts : 0;
  }

  clear(): void {
    this.lines = [];
  }
}
