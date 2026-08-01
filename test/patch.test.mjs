// 针对 dist/wloc.js 的行为测试。
// dist/wloc.js 是无源码的压缩产物，这里不读它的内部实现，只按代理工具的方式
// 喂进去一个合成的 WLOC 响应帧，再用独立写的 protobuf 解码器检查输出。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WLOC_JS = readFileSync(join(ROOT, "dist/wloc.js"), "utf8");

/* ---------- 独立的 protobuf 编解码（不复用被测代码） ---------- */

function varint(n) {
  const out = [];
  let v = Math.floor(n);
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const tag = (field, wire) => varint(field * 8 + wire);
const vField = (field, value) => [...tag(field, 0), ...varint(value)];
const lField = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const utf8 = (s) => [...Buffer.from(s, "utf8")];

// 负坐标是 10 字节补码 varint，超出 Number 精度，这里统一用 BigInt 解。
function readVarint(buf, i) {
  let val = 0n;
  let shift = 0n;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 127) << shift;
    if (!(b & 128)) return [val, i];
    shift += 7n;
  }
  throw new Error("truncated varint");
}

const TWO64 = 1n << 64n;
const TWO63 = 1n << 63n;
const signed = (v) => (v >= TWO63 ? v - TWO64 : v);

function decode(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [key, next] = readVarint(buf, i);
    i = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let value;
    if (wire === 0) [value, i] = readVarint(buf, i);
    else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, i);
      i = afterLen;
      value = buf.slice(i, i + Number(len));
      i += Number(len);
    } else if (wire === 1) {
      value = buf.slice(i, i + 8);
      i += 8;
    } else if (wire === 5) {
      value = buf.slice(i, i + 4);
      i += 4;
    } else throw new Error("unsupported wire type " + wire);
    fields.push({ field, wire, value });
  }
  return fields;
}

const pick = (fields, no) => fields.find((f) => f.field === no);

/* ---------- 合成一个 WLOC 响应 ---------- */

// 定位子消息: 1=纬度*1e8, 2=经度*1e8, 3=精度
const location = (lat, lon, acc) => [
  ...vField(1, Math.round(lat * 1e8)),
  ...vField(2, Math.round(lon * 1e8)),
  ...vField(3, acc),
];

// WiFi 条目: 1=MAC 字符串(脚本靠它识别 WiFi 块), 2=定位子消息
const wifiEntry = (mac, lat, lon) => [...lField(1, utf8(mac)), ...lField(2, location(lat, lon, 40))];

// 基站条目: 5=定位子消息
const cellEntry = (lat, lon) => [...lField(5, location(lat, lon, 800))];

// 顶层: 2=WiFi 条目, 22/24=基站条目
function wlocPayload(lat, lon) {
  return [
    ...lField(2, wifiEntry("aa:bb:cc:dd:ee:11", lat, lon)),
    ...lField(2, wifiEntry("aa:bb:cc:dd:ee:22", lat + 0.001, lon + 0.001)),
    ...lField(22, cellEntry(lat, lon)),
  ];
}

// 完整响应帧: 8 字节头 + 2 字节大端长度 + payload
function wlocBody(lat, lon) {
  const payload = wlocPayload(lat, lon);
  return Uint8Array.from([
    0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
  ]);
}

function framePayload(body) {
  const b = Uint8Array.from(body);
  const len = (b[8] << 8) | b[9];
  return b.slice(10, 10 + len);
}

// 按真实 schema 精确取出所有 WiFi/基站定位点，换算回十进制度。
// 不做递归盲搜——MAC 字符串等任意字节也会被误当成 protobuf 解出来。
function coordsOf(body) {
  const out = [];
  const readLoc = (bytes) => {
    const f = decode(bytes);
    const lat = pick(f, 1);
    const lon = pick(f, 2);
    if (lat?.wire !== 0 || lon?.wire !== 0) return;
    out.push({
      lat: Number(signed(lat.value)) / 1e8,
      lon: Number(signed(lon.value)) / 1e8,
      acc: Number(pick(f, 3)?.value ?? 0n),
    });
  };

  for (const f of decode(framePayload(body))) {
    if (f.wire !== 2) continue;
    if (f.field === 2) {
      for (const g of decode(f.value)) if (g.field === 2 && g.wire === 2) readLoc(g.value);
    } else if (f.field === 22 || f.field === 24) {
      for (const g of decode(f.value)) if (g.field === 5 && g.wire === 2) readLoc(g.value);
    }
  }
  return out;
}

/* ---------- 在 Surge 环境下跑 dist/wloc.js ---------- */

function runWloc(body, { saved = null, argument = "" } = {}) {
  return new Promise((resolve, reject) => {
    const store = new Map();
    if (saved) store.set("wloc_settings", JSON.stringify(saved));

    const sandbox = {
      console: { log: () => {} },
      TextEncoder,
      TextDecoder,
      Buffer,
      $environment: { "surge-version": "5.9.0" },
      $script: { startTime: Date.now() / 1000 },
      $argument: argument,
      $request: { url: "https://gs-loc.apple.com/clls/wloc", method: "POST" },
      $response: { status: 200, headers: { "Content-Type": "application/octet-stream" }, body },
      $persistentStore: {
        read: (k) => store.get(k) ?? null,
        write: (v, k) => (v === null ? store.delete(k) : store.set(k, v), true),
      },
      $done: (r) => resolve(r?.response ?? r),
    };
    sandbox.globalThis = sandbox;

    try {
      vm.runInNewContext(WLOC_JS, sandbox, { timeout: 15000 });
    } catch (e) {
      reject(e);
    }
    setTimeout(() => reject(new Error("$done 未被调用")), 10000).unref?.();
  });
}

const TARGET = { longitude: 121.4737, latitude: 31.2304, accuracy: 25 };
const REAL = { lat: 22.544577, lon: 113.94114 };

/* ---------- 用例 ---------- */

test("已保存坐标时，WiFi 与基站定位点全部被改写为目标坐标", async () => {
  const res = await runWloc(wlocBody(REAL.lat, REAL.lon), { saved: TARGET });
  const coords = coordsOf(res.body);

  assert.equal(coords.length, 3, "应有 2 个 WiFi + 1 个基站定位点");
  for (const c of coords) {
    assert.equal(c.lat.toFixed(6), TARGET.latitude.toFixed(6));
    assert.equal(c.lon.toFixed(6), TARGET.longitude.toFixed(6));
    assert.equal(c.acc, TARGET.accuracy);
  }
});

test("gzip 响应先解压再改写，并清掉 Content-Encoding", async () => {
  const raw = wlocBody(REAL.lat, REAL.lon);
  const res = await runWloc(new Uint8Array(gzipSync(Buffer.from(raw))), {
    saved: TARGET,
  });

  const coords = coordsOf(res.body);
  assert.equal(coords.length, 3);
  assert.equal(coords[0].lat.toFixed(6), TARGET.latitude.toFixed(6));
  assert.ok(!res.headers["Content-Encoding"], "Content-Encoding 应已删除");
  assert.equal(res.headers["Content-Length"], String(res.body.length));
});

test("未保存坐标且模块参数为默认值时透传，响应原样返回", async () => {
  const body = wlocBody(REAL.lat, REAL.lon);
  const res = await runWloc(body, {
    saved: null,
    argument: "longitude=113.94114&latitude=22.544577&accuracy=25&logLevel=info",
  });

  const coords = coordsOf(res.body ?? body);
  assert.equal(coords[0].lat.toFixed(6), REAL.lat.toFixed(6), "透传时不应改动纬度");
  assert.equal(coords[0].lon.toFixed(6), REAL.lon.toFixed(6), "透传时不应改动经度");
});

test("已保存坐标优先于模块参数", async () => {
  const res = await runWloc(wlocBody(REAL.lat, REAL.lon), {
    saved: TARGET,
    argument: "longitude=1.0&latitude=2.0&accuracy=99&logLevel=info",
  });

  const c = coordsOf(res.body)[0];
  assert.equal(c.lat.toFixed(6), TARGET.latitude.toFixed(6));
  assert.equal(c.lon.toFixed(6), TARGET.longitude.toFixed(6));
});

test("南半球/西半球负坐标改写正确", async () => {
  const south = { longitude: -58.3816, latitude: -34.6037, accuracy: 25 };
  const res = await runWloc(wlocBody(REAL.lat, REAL.lon), { saved: south });
  const c = coordsOf(res.body)[0];

  assert.equal(c.lat.toFixed(6), south.latitude.toFixed(6));
  assert.equal(c.lon.toFixed(6), south.longitude.toFixed(6));
});
