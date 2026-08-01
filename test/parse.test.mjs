// worker/src/parse.js 的纯函数测试：链接坐标提取 + GCJ-02/WGS84 换算。
// 坐标系搞错 = 定位偏几百米，这部分必须有回归保护。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFromString,
  gcj02ToWgs84,
  wgs84ToGcj02,
  round6,
  safeDecode,
} from "../worker/src/parse.js";

test("苹果地图链接: coordinate=纬度,经度", () => {
  const hit = extractFromString(
    "https://maps.apple.com/?address=%E4%B8%8A%E6%B5%B7&coordinate=31.239692,121.499809&name=%E4%B8%9C%E6%96%B9%E6%98%8E%E7%8F%A0"
  );
  assert.equal(hit.src, "apple");
  assert.equal(hit.lat, 31.239692);
  assert.equal(hit.lon, 121.499809);
  assert.equal(hit.name, "东方明珠");
});

test("高德分享链接: ?p=POIID,纬度,经度,名称", () => {
  const hit = extractFromString("https://surl.amap.com/x?p=B001,31.239692,121.499809,东方明珠,上海市");
  assert.equal(hit.src, "amap");
  assert.equal(hit.lat, 31.239692);
  assert.equal(hit.lon, 121.499809);
  assert.equal(hit.name, "东方明珠");
});

test("高德新版分享链接: ?q=纬度,经度,名称（URL 编码逗号）", () => {
  const hit = extractFromString("https://amap.com/place?q=31.239692%2C121.499809%2C%E5%A4%96%E6%BB%A9");
  assert.equal(hit.src, "amap");
  assert.equal(hit.lat, 31.239692);
  assert.equal(hit.name, "外滩");
});

test("纯文本坐标", () => {
  const hit = extractFromString("目的地 31.2304,121.4737 附近");
  assert.equal(hit.src, "text");
  assert.equal(hit.lat, 31.2304);
  assert.equal(hit.lon, 121.4737);
});

test("无坐标时返回 null", () => {
  assert.equal(extractFromString("https://example.com/nothing"), null);
  assert.equal(extractFromString(""), null);
});

test("GCJ-02 → WGS84 迭代反算残差小于 0.1 米", () => {
  // 国内几个点：上海、北京、深圳、乌鲁木齐
  const points = [
    [31.239692, 121.499809],
    [39.90874, 116.397499],
    [22.544577, 113.94114],
    [43.825592, 87.616848],
  ];
  for (const [lat, lon] of points) {
    const wgs = gcj02ToWgs84(lat, lon);
    const back = wgs84ToGcj02(wgs.lat, wgs.lon);
    // 1e-6 度纬度约 0.11 米
    const errM = Math.hypot((back.lat - lat) * 111320, (back.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180));
    assert.ok(errM < 0.1, `${lat},${lon} 往返误差 ${errM.toFixed(4)}m 超过 0.1m`);
  }
});

test("GCJ-02 偏移量量级合理（国内应偏移数百米）", () => {
  const wgs = gcj02ToWgs84(31.239692, 121.499809);
  const dLat = Math.abs(wgs.lat - 31.239692) * 111320;
  const dLon = Math.abs(wgs.lon - 121.499809) * 111320 * Math.cos((31.24 * Math.PI) / 180);
  const dist = Math.hypot(dLat, dLon);
  assert.ok(dist > 100 && dist < 1000, `上海偏移 ${dist.toFixed(0)}m，应在 100~1000m 之间`);
});

test("境外坐标不做换算（out_of_china）", () => {
  const tokyo = gcj02ToWgs84(35.6812, 139.7671);
  assert.equal(tokyo.lat, 35.6812);
  assert.equal(tokyo.lon, 139.7671);

  const ny = gcj02ToWgs84(40.7128, -74.006);
  assert.equal(ny.lat, 40.7128);
  assert.equal(ny.lon, -74.006);
});

test("round6 保留 6 位小数", () => {
  assert.equal(round6(31.23969212345), 31.239692);
  assert.equal(round6("121.4999994"), 121.499999);
});

test("safeDecode 遇到坏编码不抛错", () => {
  assert.equal(safeDecode("%E4%B8%8A%E6%B5%B7"), "上海");
  assert.equal(safeDecode("%E4%B8"), "%E4%B8");
  assert.equal(safeDecode(""), "");
});
