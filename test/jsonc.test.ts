import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeJsoncFile, parseJsonc, stripJsonComments } from '../src/core/jsonc';

test('stripJsonComments 保留字符串中的注释符号', () => {
  const input = '{"url": "http://example.com//path", /* block */ "n": 1}';
  const stripped = stripJsonComments(input);
  assert.ok(stripped.includes('http://example.com//path'));
  assert.ok(!stripped.includes('block'));
});

test('parseJsonc 支持注释与尾逗号', () => {
  const value = parseJsonc<{ a: number; b: string }>(`{
    // comment
    "a": 1,
    "b": "x", /* trailing */
  }`);
  assert.deepEqual(value, { a: 1, b: 'x' });
});

test('mergeJsoncFile 创建并合并 JSONC 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'esmith-jsonc-'));
  try {
    const file = join(dir, 'settings.json');
    const created = mergeJsoncFile(file, { a: 1 });
    assert.equal(created.status, 'created');

    writeFileSync(file, '{\n  // keep comment\n  "a": 1,\n  "b": 2,\n}\n', 'utf8');
    const merged = mergeJsoncFile(file, { a: 3 });
    assert.equal(merged.status, 'merged');
    assert.equal(merged.merged?.a, 3);
    assert.equal(merged.merged?.b, 2);

    writeFileSync(file, '{ invalid', 'utf8');
    const skipped = mergeJsoncFile(file, { a: 4 });
    assert.equal(skipped.status, 'skipped');
    assert.equal(readFileSync(file, 'utf8'), '{ invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
