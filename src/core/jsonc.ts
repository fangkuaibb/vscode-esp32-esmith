import * as fs from 'fs';
import * as path from 'path';

/**
 * 去掉 JSONC 中的 // 与 /* *\/ 注释，保留字符串内的内容。
 */
export function stripJsonComments(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

export function parseJsonc<T = Record<string, unknown>>(text: string): T | undefined {
  try {
    const withoutComments = stripJsonComments(text);
    // 去掉对象/数组末尾多余的逗号。
    const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(withoutTrailingCommas) as T;
  } catch {
    return undefined;
  }
}

export function readJsoncFile<T = Record<string, unknown>>(filePath: string): T | undefined {
  try {
    return parseJsonc<T>(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

export interface MergeJsoncResult {
  path: string;
  status: 'created' | 'merged' | 'skipped';
  merged?: Record<string, unknown>;
  reason?: string;
}

/**
 * 合并 JSONC 文件。无法解析时返回 skipped，绝不覆盖原文件。
 */
export function mergeJsoncFile(
  filePath: string,
  updates: Record<string, unknown>
): MergeJsoncResult {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const merged = { ...updates };
    fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return { path: filePath, status: 'created', merged };
  }

  const existing = readJsoncFile(filePath);
  if (!existing) {
    return { path: filePath, status: 'skipped', reason: 'JSONC 或格式无法解析' };
  }

  const merged = { ...existing, ...updates };
  fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { path: filePath, status: 'merged', merged };
}
