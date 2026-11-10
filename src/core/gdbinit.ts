import * as fs from 'fs';
import * as path from 'path';

/**
 * 官方扩展生成的 build/gdbinit/symbols 可能把 ROM ELF 路径拼成
 * `.../esp-rom-elfs/20241011esp32s3_rev0_rom.elf`，缺少版本目录分隔符。
 * 这里只做路径规范化，不改动其它内容。
 */
export function normalizeRomElfPaths(text: string): string {
  return text.replace(
    /(esp-rom-elfs[\\/])(\d{8})(esp[0-9a-z]+_rev\d+_rom\.elf)/gi,
    (_match, prefix: string, version: string, file: string) =>
      `${prefix}${version}/${file}`
  );
}

/**
 * 扫描 build/gdbinit 下的文本文件并就地修正 ROM ELF 路径。
 * 返回被修改的文件列表。
 */
export function repairGdbinitRomElfPaths(buildDir: string): string[] {
  const gdbinitDir = path.join(buildDir, 'gdbinit');
  if (!fs.existsSync(gdbinitDir)) {
    return [];
  }
  const changed: string[] = [];
  for (const file of walk(gdbinitDir)) {
    try {
      const original = fs.readFileSync(file, 'utf8');
      const next = normalizeRomElfPaths(original);
      if (next !== original) {
        fs.writeFileSync(file, next, 'utf8');
        changed.push(file);
      }
    } catch {
      // 跳过不可读文件（例如二进制或权限不足）
    }
  }
  return changed;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}
