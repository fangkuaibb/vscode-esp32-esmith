import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  normalizeRomElfPaths,
  repairGdbinitRomElfPaths,
} from '../src/core/gdbinit';

test('修复 ROM ELF 缺失的版本目录分隔符', () => {
  const input =
    'add-symbol-file C:/Espressif/tools/esp-rom-elfs/20241011esp32s3_rev0_rom.elf 0x0';
  const output = normalizeRomElfPaths(input);
  assert.match(output, /esp-rom-elfs\/20241011\/esp32s3_rev0_rom\.elf/);
});

test('已正确的路径保持不变', () => {
  const input =
    'add-symbol-file C:/Espressif/tools/esp-rom-elfs/20241011/esp32s3_rev0_rom.elf 0x0';
  assert.equal(normalizeRomElfPaths(input), input);
});

test('就地修正 build/gdbinit/symbols', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-gdbinit-'));
  const gdbinit = path.join(dir, 'gdbinit');
  fs.mkdirSync(gdbinit, { recursive: true });
  const symbols = path.join(gdbinit, 'symbols');
  fs.writeFileSync(
    symbols,
    'add-symbol-file C:\\Espressif\\tools\\esp-rom-elfs\\20241011esp32s3_rev0_rom.elf 0x0\n',
    'utf8'
  );
  const changed = repairGdbinitRomElfPaths(dir);
  assert.deepEqual(changed, [symbols]);
  assert.match(fs.readFileSync(symbols, 'utf8'), /20241011\/esp32s3_rev0_rom\.elf/);
  fs.rmSync(dir, { recursive: true, force: true });
});
