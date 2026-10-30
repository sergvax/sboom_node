import test from 'node:test';
import assert from 'node:assert/strict';

import { field, decode, varint } from '../lib/tlv.js';

test('varint: однобайтовые и многобайтовые значения', () => {
  assert.deepEqual([...varint(0)], [0]);
  assert.deepEqual([...varint(127)], [127]);
  assert.deepEqual([...varint(128)], [0x80, 0x01]);
  assert.deepEqual([...varint(300)], [0xac, 0x02]);
});

test('field kind=0 / kind=2 / kind=5 и обратный decode', () => {
  const buf = Buffer.concat([
    field(1, 0, 2),
    field(2, 2, 'hello'),
    field(5, 2, Buffer.from([0x00, 0xff])),
    field(7, 5, 1.5),
  ]);
  const out = decode(buf);
  assert.equal(out[1], 2);
  assert.equal(out[2], 'hello');
  assert.deepEqual(Buffer.from(out[5], 'hex'), Buffer.from([0x00, 0xff]));
  assert.equal(out[7], 1.5);
});

test('nested envelope декодируется рекурсивно', () => {
  const body = field(12, 2, field(1, 2, Buffer.alloc(0)));
  const env = Buffer.concat([
    field(1, 0, 2),
    field(2, 2, 'req-id'),
    field(5, 2, body),
    field(6, 0, 1),
    field(7, 2, 'Sboom'),
    field(10, 0, 1),
    field(11, 2, 'client-id'),
  ]);
  const out = decode(env);
  assert.equal(out[2], 'req-id');
  assert.equal(out[6], 1);
  assert.equal(out[10], 1);
  assert.equal(out[11], 'client-id');
  assert.equal(out[5][12][1], '');
});

test('JSON внутри TLV остаётся строкой, а не nested-мусором', () => {
  const json = '{"volume":{"muted":false,"percent":42}}';
  const out = decode(field(5, 2, json));
  assert.equal(out[5], json);
});

test('битый/обрезанный буфер не бросает исключение', () => {
  const buf = Buffer.concat([field(1, 0, 2), Buffer.from([0xf0, 0xff])]);
  assert.doesNotThrow(() => decode(buf));
});
