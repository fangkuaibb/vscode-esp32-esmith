import * as fs from 'fs';
import * as path from 'path';

/**
 * 官方扩展（CMake/Ninja）偶尔会把 compile_commands.json 的内容追加到 build.ninja 尾部，
 * 之后任何增量构建都会以 "expected variable name" / "lexing error" 失败。
 * ESmith 不写构建文件，但可以在构建前识别这种状态，避免白等一次失败构建。
 */
const JSON_MARKER_DIRECTORY = /"directory"\s*:/;
const JSON_MARKER_FILE = /"file"\s*:/;

export function detectCorruptedBuildNinja(
  projectRoot: string,
  buildDir: string
): string | undefined {
  const file = path.join(path.resolve(projectRoot, buildDir), 'build.ninja');
  try {
    const stat = fs.statSync(file);
    if (stat.size < 1024) {
      return undefined;
    }
    const chunk = Math.min(64 * 1024, stat.size);
    const buffer = Buffer.alloc(chunk);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, chunk, stat.size - chunk);
    } finally {
      fs.closeSync(fd);
    }
    const tail = buffer.toString('utf8');
    return JSON_MARKER_DIRECTORY.test(tail) && JSON_MARKER_FILE.test(tail)
      ? file
      : undefined;
  } catch {
    return undefined;
  }
}

/** ninja 解析 build.ninja 失败时给出的错误行。 */
export const NINJA_CORRUPT_PATTERN =
  /build\.ninja:\d+[^\n]*(?:lexing error|expected variable name)|ninja:\s+error:\s+build\.ninja/i;

export function isNinjaCorruptionError(text: string | undefined): boolean {
  return Boolean(text) && NINJA_CORRUPT_PATTERN.test(String(text));
}

export const BUILD_CORRUPT_HINT =
  '构建目录已损坏：build.ninja 被追加了 JSON（compile_commands 内容），ninja 无法解析。请执行 esmith_build { clean: true } 重新生成构建目录。';
