import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import {
  detectCorruptedBuildNinja,
  isNinjaCorruptionError,
} from '../src/core/buildSanity';
import { mergeDiagnostics } from '../src/core/compileErrors';

const roots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esmith-build-sanity-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  return root;
}

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('正常的 build.ninja 不会被判为损坏', () => {
  const root = makeProject();
  const text = ['rule cc', '  command = gcc -c $in -o $out', 'build app.elf: cc main.c'].join(
    '\n'
  );
  fs.writeFileSync(path.join(root, 'build', 'build.ninja'), text.repeat(100));
  assert.equal(detectCorruptedBuildNinja(root, 'build'), undefined);
});

test('尾部被追加单行 compile_commands JSON 时能识别', () => {
  const root = makeProject();
  const clean = 'rule cc\n  command = gcc -c $in -o $out\n'.repeat(100);
  fs.writeFileSync(
    path.join(root, 'build', 'build.ninja'),
    `${clean}{"directory":"x","file":"y"}`
  );
  assert.equal(
    detectCorruptedBuildNinja(root, 'build'),
    path.join(root, 'build', 'build.ninja')
  );
});

test('ninja 解析错误能映射为构建目录损坏', () => {
  assert.equal(
    isNinjaCorruptionError('ninja: error: build.ninja:25869: lexing error'),
    true
  );
  assert.equal(
    isNinjaCorruptionError('ninja: error: build.ninja:4337: expected variable name'),
    true
  );
  assert.equal(isNinjaCorruptionError('main.c:1:2: error: #error TEST'), false);
});

test('同一诊断在大小写/分隔符不同的路径下只保留一条', () => {
  const merged = mergeDiagnostics(
    [
      {
        file: 'E:\\_esmith_bridge_test\\main\\main.c',
        line: 1,
        column: 2,
        severity: 'error',
        message: '#error TEST',
        raw: '',
      },
    ],
    [
      {
        file: 'E:/_esmith_bridge_test/main/main.c',
        line: 1,
        column: 2,
        severity: 'error',
        message: '#error TEST',
        raw: '',
      },
      {
        file: 'E:/_esmith_bridge_test/main/main.c',
        line: 9,
        column: 1,
        severity: 'error',
        message: 'other',
        raw: '',
      },
    ]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].file, 'E:\\_esmith_bridge_test\\main\\main.c');
});
