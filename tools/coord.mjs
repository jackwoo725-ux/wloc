#!/usr/bin/env node
// 坐标换算 + 生成写入网址，供「不部署 worker」的用法使用。
//
//   node tools/coord.mjs 31.239692 121.499809          # 默认按 GCJ-02 输入（国内地图 App 复制出来的）
//   node tools/coord.mjs 35.6812 139.7671 --wgs84      # 已经是 WGS84，不换算
//   node tools/coord.mjs "https://maps.apple.com/?coordinate=31.239692,121.499809"
//
// 输出可直接在 Safari 打开的写入网址。

import { gcj02ToWgs84, round6, extractFromString } from "../worker/src/parse.js";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.filter((a) => !a.startsWith("--"));

if (args.length === 0) {
  console.error(`用法:
  node tools/coord.mjs <纬度> <经度> [--wgs84] [--acc=25]
  node tools/coord.mjs "<地图链接或含坐标的文本>" [--wgs84] [--acc=25]

默认把输入当作 GCJ-02（高德/腾讯/苹果中国大陆）并换算为 WGS84。
--wgs84  输入已是 WGS84（GPS 原始坐标 / 境外地图），跳过换算。`);
  process.exit(1);
}

const accFlag = [...flags].find((f) => f.startsWith("--acc="));
const acc = accFlag ? parseInt(accFlag.slice(6), 10) : 25;

let lat;
let lon;
let name = "";
let src = "手动输入";

if (args.length >= 2 && !Number.isNaN(Number(args[0])) && !Number.isNaN(Number(args[1]))) {
  lat = Number(args[0]);
  lon = Number(args[1]);
} else {
  const hit = extractFromString(args[0]);
  if (!hit) {
    console.error("✗ 没能从输入里解析出坐标。短链需要跟 302 跳转，请用已部署的 worker /api/parse。");
    process.exit(1);
  }
  ({ lat, lon, name } = hit);
  src = hit.src;
}

if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
  console.error(`✗ 坐标超出范围: lat=${lat} lon=${lon}（注意顺序是「纬度 经度」）`);
  process.exit(1);
}

// 境外坐标 gcj02ToWgs84 内部会 out_of_china 判断并原样返回
const wgs = flags.has("--wgs84") ? { lat, lon } : gcj02ToWgs84(lat, lon);
const outLat = round6(wgs.lat);
const outLon = round6(wgs.lon);

const shifted = outLat !== round6(lat) || outLon !== round6(lon);
const meters = shifted
  ? Math.hypot(
      (wgs.lat - lat) * 111320,
      (wgs.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180)
    )
  : 0;

console.log(`来源      : ${src}${name ? ` (${name})` : ""}`);
console.log(`输入      : ${round6(lat)}, ${round6(lon)}${flags.has("--wgs84") ? " [WGS84]" : " [GCJ-02]"}`);
console.log(
  `WGS84     : ${outLat}, ${outLon}` +
    (shifted ? `  (偏移 ${meters.toFixed(0)}m)` : "  (未换算：境外或已是 WGS84)")
);
console.log("");
console.log("在 Safari 打开以下网址写入（需模块已启用）：");
console.log(`  https://gs-loc.apple.com/wloc-settings/save?lon=${outLon}&lat=${outLat}&acc=${acc}`);
console.log("");
console.log("查询当前 / 恢复真实定位：");
console.log("  https://gs-loc.apple.com/wloc-settings/save?action=query");
console.log("  https://gs-loc.apple.com/wloc-settings/save?action=clear");
