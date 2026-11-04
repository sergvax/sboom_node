/**
 * Бинарный TLV-кодек протокола SberBoom (protobuf-подобный).
 *
 * kind=0 → varint
 * kind=2 → length-delimited (bytes / nested message / UTF-8)
 * kind=5 → fixed32 (float32 LE, используется в op=23 playback speed)
 *
 * Порт custom_components/sboom_ha/_tlv.py.
 */

/** @param {number} n @returns {Buffer} */
export function varint(n) {
  n = Math.max(0, Math.floor(Number(n) || 0));
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

/**
 * @param {number} tag
 * @param {0|2|5} kind
 * @param {number|Buffer|string} payload
 * @returns {Buffer}
 */
export function field(tag, kind, payload) {
  const key = varint((tag << 3) | kind);
  if (kind === 0) return Buffer.concat([key, varint(payload)]);
  if (kind === 2) {
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    return Buffer.concat([key, varint(buf.length), buf]);
  }
  if (kind === 5) {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(Number(payload), 0);
    return Buffer.concat([key, b]);
  }
  throw new Error(`unsupported TLV kind: ${kind}`);
}

/** @param {Buffer} data @param {number} pos @returns {[number, number]|null} */
function readVarint(data, pos) {
  let value = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    value += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return [value, pos];
    shift += 7;
    if (shift > 63) return null;
  }
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @param {Buffer} buf @returns {string|null} */
function tryUtf8(buf) {
  try {
    const s = utf8.decode(buf);
    // Python str.isprintable(): без управляющих символов, кроме \n и \t
    // eslint-disable-next-line no-control-regex
    if (/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/u.test(s)) return s;
    return null;
  } catch {
    return null;
  }
}

/**
 * Декодер с сохранением повторяющихся тегов (для proto `repeated`-полей,
 * например списков Bluetooth-устройств op=19/21).
 *
 * Возвращает `{tag: [values...]}`. Length-delimited значения — СЫРЫЕ Buffer
 * (без авто-рекурсии), varint — number, fixed32 — Buffer(4). Для вложенных
 * сообщений декодер вызывается повторно.
 *
 * Порт `decode_repeated` из _tlv.py.
 * @param {Buffer} data
 * @returns {Record<number, any[]>}
 */
export function decodeRepeated(data) {
  const out = {};
  let i = 0;
  const n = data.length;
  while (i < n) {
    const keyRes = readVarint(data, i);
    if (!keyRes) return out;
    let key;
    [key, i] = keyRes;
    const tag = Math.floor(key / 8);
    const kind = key & 0x7;
    const push = (value) => {
      if (!out[tag]) out[tag] = [];
      out[tag].push(value);
    };

    if (kind === 0) {
      const vRes = readVarint(data, i);
      if (!vRes) return out;
      let v;
      [v, i] = vRes;
      push(v);
    } else if (kind === 2) {
      const lenRes = readVarint(data, i);
      if (!lenRes) return out;
      let len;
      [len, i] = lenRes;
      if (i + len > n) return out;
      push(data.subarray(i, i + len));
      i += len;
    } else if (kind === 5) {
      if (i + 4 > n) return out;
      push(data.subarray(i, i + 4));
      i += 4;
    } else {
      break;
    }
  }
  return out;
}

/**
 * Рекурсивный декодер. Возвращает объект с ЧИСЛОВЫМИ тегами (как строковые
 * ключи JS): { 5: { 12: {...} }, 2: 'uuid' }.
 * @param {Buffer} data
 * @returns {Record<string, any>}
 */
export function decode(data) {
  const out = {};
  let i = 0;
  const n = data.length;
  while (i < n) {
    const keyRes = readVarint(data, i);
    if (!keyRes) return out;
    let key;
    [key, i] = keyRes;
    const tag = Math.floor(key / 8);
    const kind = key & 0x7;

    if (kind === 0) {
      const vRes = readVarint(data, i);
      if (!vRes) return out;
      let v;
      [v, i] = vRes;
      out[tag] = v;
    } else if (kind === 2) {
      const lenRes = readVarint(data, i);
      if (!lenRes) return out;
      let len;
      [len, i] = lenRes;
      const payload = data.subarray(i, i + len);
      i += len;
      const s = tryUtf8(payload);
      if (s !== null) {
        out[tag] = s;
        continue;
      }
      const nested = decode(payload);
      out[tag] = Object.keys(nested).length ? nested : payload.toString('hex');
    } else if (kind === 5) {
      if (i + 4 > n) return out;
      out[tag] = data.readFloatLE(i);
      i += 4;
    } else {
      break;
    }
  }
  return out;
}
