import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUsbLocation } from '../src/core/openocdDevice';

test('接受 OpenOCD 的 bus-port 位置', () => {
  assert.equal(normalizeUsbLocation('1-3'), '1-3');
  assert.equal(normalizeUsbLocation('1-7'), '1-7');
  assert.equal(normalizeUsbLocation('2-1.4.3'), '2-1.4.3');
});

test('拒绝非 bus-port 形式', () => {
  assert.equal(normalizeUsbLocation(undefined), undefined);
  assert.equal(normalizeUsbLocation(''), undefined);
  assert.equal(normalizeUsbLocation('adapter usb location 1-3'), undefined);
  assert.equal(normalizeUsbLocation('0000.0014.0000.003.000.000.000.000.000'), undefined);
  assert.equal(normalizeUsbLocation('1-'), undefined);
  assert.equal(normalizeUsbLocation('-3'), undefined);
});
