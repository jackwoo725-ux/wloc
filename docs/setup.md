# 本 fork 的部署与使用

针对 `jackwoo725-ux/wloc` 这份 fork。和上游的区别：模块脚本地址指向本仓库、不再指向任何公共 worker 实例。

---

## 0. 先推送仓库（必做）

模块通过 `raw.githubusercontent.com` 拉脚本，仓库没推上去这些地址就是 404：

```bash
git add -A && git commit -m "chore: 自部署改造" && git push
```

仓库必须是 **public**，否则 raw 地址需要鉴权，代理工具拉不到。

---

## 1. 装模块

在代理工具里订阅对应格式（都指向本仓库）：

| 工具 | 订阅地址 |
|---|---|
| Surge / Egern | `https://raw.githubusercontent.com/jackwoo725-ux/wloc/refs/heads/main/modules/wloc.sgmodule` |
| Quantumult X | `https://raw.githubusercontent.com/jackwoo725-ux/wloc/refs/heads/main/modules/wloc.conf` |
| Loon | `https://raw.githubusercontent.com/jackwoo725-ux/wloc/refs/heads/main/modules/wloc.lpx` |
| Stash | `https://raw.githubusercontent.com/jackwoo725-ux/wloc/refs/heads/main/modules/wloc.stoverride` |
| Shadowrocket | `https://raw.githubusercontent.com/jackwoo725-ux/wloc/refs/heads/main/modules/wloc.module` |

然后：

1. **启用模块**
2. **开启 MITM**，主机名包含 `gs-loc.apple.com` 和 `gs-loc-cn.apple.com`（模块里已带，确认没被别的配置覆盖）
3. **安装并信任 CA 证书** — 「设置 → 通用 → 关于本机 → 证书信任设置」里把证书打开。**只装不信任是最常见的失败原因。**
4. 代理必须处于连接状态（有 VPN 图标）

---

## 2. 改定位

### 方式 A：直接开网址（推荐，零外部依赖）

坐标写入走的是一个假接口 `gs-loc.apple.com/wloc-settings/save`，它被本地模块拦下，**不会真的发给苹果**，也不经过任何第三方。

先算好 WGS84 坐标（见第 3 节），然后在 **Safari** 打开：

```
https://gs-loc.apple.com/wloc-settings/save?lon=121.49536&lat=31.241692&acc=25
```

返回 `{"success":true,...}` 即写入成功。配套网址：

```
查询当前：https://gs-loc.apple.com/wloc-settings/save?action=query
清除恢复：https://gs-loc.apple.com/wloc-settings/save?action=clear
```

> 必须用 Safari 且当前网络走代理，请求才会被拦截。返回不是 JSON 而是报错 → 说明没被拦到，回第 1 节检查。

### 方式 B：自部署选点页面（有地图 UI）

见第 5 节。部署完在 Safari 打开你的 worker 地址，点地图选点 →「储存到设备」。

### 方式 C：快捷指令

上游作者做的快捷指令最省事，但**写死了他的 worker 域名**，你选的每个目标坐标都会发到第三方服务器。要用的话，自部署 worker 后进快捷指令把域名改成自己的。

---

## 3. 坐标系：必须是 WGS84

脚本写进去的坐标会被当作 **WGS84**（GPS 原始坐标系）。

国内地图 App（高德、腾讯、苹果地图中国大陆）显示和复制出来的是 **GCJ-02 火星坐标**，比 WGS84 偏移 **300~800 米**。直接拿 GCJ-02 去写，定位就会差这么多。

仓库自带换算工具：

```bash
node tools/coord.mjs 31.239692 121.499809
```

```
输入      : 31.239692, 121.499809 [GCJ-02]
WGS84     : 31.241692, 121.49536  (偏移 478m)

在 Safari 打开以下网址写入（需模块已启用）：
  https://gs-loc.apple.com/wloc-settings/save?lon=121.49536&lat=31.241692&acc=25
```

也支持直接丢链接和已是 WGS84 的坐标：

```bash
node tools/coord.mjs "https://maps.apple.com/?coordinate=39.908740,116.397499"
node tools/coord.mjs 35.6812 139.7671 --wgs84     # 境外坐标本来就不偏移
```

> 境外坐标（`out_of_china` 判定）不做换算，原样使用。

**港澳台是例外，必须加 `--wgs84`。** 这三地的地图给的本来就是 WGS84，没有 GCJ-02 偏移；但 `parse.js` 里的 `out_of_china` 是个粗矩形，把它们也圈进了"中国境内"，不加 `--wgs84` 会被多换算一次、偏出 500m 以上。`tools/coord.mjs` 检测到这三个区域会出声提醒，但**选点页面和 worker 的 `/api/parse` 没有这个保护**——在港澳台用选点页面会偏，用直接网址法 + `--wgs84` 才准。

---

## 4. 恢复真实定位

按可靠程度排序：

1. **关闭 / 删除模块** — 最彻底，脚本不再拦截。
2. **清除已存坐标** — 打开 `.../wloc-settings/save?action=clear`。清掉后脚本进入透传模式，不改响应。
   - ⚠️ 前提是模块参数保持默认值（经度 113.94114 / 纬度 22.544577）。若你手改过模块参数，清除持久化数据**不会**恢复真实定位，脚本会继续用模块参数里的坐标。

**iOS 26 及以上必须重启设备。** `locationd` 会把定位结果长时间缓存在内存里，飞行模式、关定位服务都清不掉这个缓存。不重启的话，即使日志显示"已修改"，系统仍在用旧坐标。iOS 15~18 一般不用重启。

---

## 5. 自部署 worker（可选）

只在你想要地图选点 UI 或想让快捷指令走自己的服务器时才需要。

```bash
cd worker
npm install
npx wrangler login        # 交互式 OAuth，需要在浏览器里授权
npm run deploy
```

部署完得到 `https://wloc-spoofer.<你的子域名>.workers.dev`。然后把仓库里的占位符全部替换：

```bash
grep -rl "YOUR-WORKER.workers.dev" README.md modules/ | xargs sed -i '' 's#YOUR-WORKER.workers.dev#你的真实域名#g'
```

改完重新 push，代理工具里更新一次模块订阅。

本地先跑一遍验证：

```bash
cd worker && npx wrangler dev --port 8788 --local
curl "http://localhost:8788/api/parse?u=https%3A%2F%2Fmaps.apple.com%2F%3Fcoordinate%3D31.239692%2C121.499809&format=json"
# {"lat":31.241692,"lon":121.49536,"name":""}
```

免费额度每天 10 万次请求，个人用绰绰有余。

---

## 6. 已知限制

- **只改网络定位（WiFi/基站），不碰 GPS 硬件。** 室外 GPS 信号好的时候，iOS 会优先采信 GPS，虚拟定位可能不生效或来回跳。**室内 / WiFi 定位为主的场景效果最好。**
- 部分 App 有自己的反作弊（交叉校验 GPS、气压计、IP 归属地、运动传感器），仅改 WLOC 不一定骗得过。
- `dist/wloc.js` 和 `dist/wloc-settings.js` 是**没有源码的压缩产物**，仓库里只有构建结果。想改脚本逻辑只能改压缩代码，或回上游要源码。

---

## 7. 排查

先看代理工具的脚本日志（模块参数 `logLevel` 调成 `debug`）。

| 现象 | 原因 |
|---|---|
| 打开 save 网址不返回 JSON | 请求没被拦截：模块没启用 / MITM 没开 / 证书没信任 / 没走代理 |
| 日志有「已修改」但定位没变 | iOS 26+ 定位缓存 → **重启设备** |
| 定位偏了几百米 | 用了 GCJ-02 坐标没换算 → `node tools/coord.mjs` |
| 日志出现「透传模式」 | 没存坐标，或存的值被清了 |
| 定位在真实位置和目标位置之间跳 | GPS 在起作用，去室内或关掉 GPS 依赖强的场景 |
| 模块订阅 404 | 仓库没 push，或仓库是 private |

---

## 8. 跑测试

```bash
npm test
```

覆盖 protobuf 改写（含 gzip、透传、参数优先级、负坐标）和坐标换算（GCJ-02 往返精度、境外跳过、链接解析）。改动 `dist/` 或 `worker/src/parse.js` 后应先跑一遍。
