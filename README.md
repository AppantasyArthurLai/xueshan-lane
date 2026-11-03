# 雪隧王道 xueshan-lane

國道5號雪山隧道「左線還是右線？」的小工具。根據隧道內車輛偵測器（VD）的即時資料，**推估**左線（內側）與右線（外側）的平均車速、前方車輛數與慢車疑似數量，並給出一個大大的建議：**建議走左線／建議走右線／兩線差不多**。可切換 **北上（往台北）／南下（往宜蘭）**，手機一眼看懂。

> **非官方專案**，與任何既有服務、網站、App 或政府機關皆無關。
> 畫面上**所有數值皆為推估**，不是實際數到的車輛數，可能有誤差，僅供參考。
> **安全第一：請勿在駕駛中操作手機。** 請在出發前或由乘客查看；雪山隧道內禁止變換車道，請在進隧道前依現場標誌決定車道。

## 資料來源

- 交通部「TDX 運輸資料流通服務」高速公路 VD 即時資料（車道層級：車速、佔有率、車流量）。
- 未設定 TDX 金鑰時，自動使用**模擬資料**（畫面會明確標示「模擬資料」）。
- **TDX 連線失敗時不會改用模擬資料**：API 回應 `source: "unavailable"`、`unavailable: true`、`error`，車速為 `null`，畫面顯示「資料暫時無法取得」。失敗結果只快取 15 秒，之後自動重試。

### TDX 串接決策（2026-11-03 實測）

- **一次呼叫供南北兩向**：`GET /api/basic/v2/Road/Traffic/Live/VD/Freeway?$filter=contains(VDID,'-N5-')`（約 183 支國5 VD），伺服器快取 60 秒（TDX 上游每 60 秒更新），同時多個請求共用同一個 in-flight 呼叫。全天每分鐘最多 1 次 ≈ 每月 4.3 萬次，在銅級會員額度內。
- **不再呼叫 VD 靜態清單**：方向與里程直接由 VDID `VD-N5-{N|S}-{里程}-M-…` 解析；南下 15.0–28.3K（21 支，15.139K–28.236K）、北上 15.0–28.0K（19 支，15.488K–27.779K，排除 28.420K 隧道外）。
- **權杖**：client credentials，效期 24h，快取至到期前 1 小時；遇 401 清除權杖並重試一次。呼叫間隔 ≥ 250ms（TDX 上限 5 req/s）。
- **樣本過濾**：`Status != 0` 的 VD、`ErrorType` 非 `diag0` 的車道、速度 < 0（-99）以及「速度 0 且車流 0」（無車）都排除；車流加總 S/L/T 三種車型。
- **LaneID 0 = 左線（內側）只依 TDX 規格，尚未以現場畫面驗證**（`config.laneMapVerified: false`，API 回應會帶 `laneMapVerified` / `laneMapNote`）。
- **資料時間**：取隧道內 VD 最新的 `DataCollectTime`。實測收到時已落後約 2–5 分鐘，因此前端「資料過舊」門檻設為 8 分鐘。
- 遲滯邏輯（< 5 km/h 差不多、> 8 km/h 才換線）與「推估」標示不變。

### 驗證腳本

```bash
node scripts/verify-tdx.js
```
抓一次即時資料，檢查兩方向 VD 數、每支 2 車道、有效偵測器比例、資料時間，列出左右線推估車速；紀錄寫到 `data/verify/<時間>.json`（不含金鑰／權杖，`data/` 不進版控），並與前一次紀錄比對差異。檢查全過 exit 0，否則 exit 1。

推估公式（白話版見網站上的「推估邏輯說明」頁 `/explain.html`）：

| 項目 | 公式 |
|---|---|
| 平均車速 | 以流量加權平均各偵測器的車速 |
| 前方車輛約 N 台 | 密度（台/公里）= 每小時流量 ÷ 車速；N ≈ 平均密度 × 12.9 公里 |
| 慢車疑似數量 | （車速 < 60 km/h 或 佔有率 ≥ 25% 的樣本比例）× 前方車輛數 |
| 建議 | 兩線差 < 5 km/h → 兩線差不多；否則建議較快的一線。遲滯：已建議某線時，另一線需快 **超過 8 km/h** 才改建議 |

## 取得 TDX API 金鑰

1. 到 <https://tdx.transportdata.tw> 註冊會員並登入。
2. 進入「會員中心 → API 金鑰」，建立／查看金鑰，取得 **Client Id** 與 **Client Secret**。
3. 複製設定檔並填入：
   ```bash
   cp .env.example .env
   # 編輯 .env
   TDX_CLIENT_ID=你的 Client Id
   TDX_CLIENT_SECRET=你的 Client Secret
   ```
4. 重新啟動伺服器（`./scripts/start.sh` 會自動停掉舊的再啟動）。`/api/health` 的 `mode` 會顯示 `tdx`。

### `config/tunnel-vd.json`

`verified: true`（2026-11-03 以實際資料核對方向、里程範圍、車道數、回報週期）。`laneMapVerified: false`：LaneID→左／右線仍僅依規格。`explicitVDIDs` 若有填，會優先於里程篩選。

## 執行

需要 Node.js 20 以上。

```bash
npm install
npm start                 # 前景執行，預設 http://127.0.0.1:3410
./scripts/start.sh        # 背景執行（setsid nohup），log 在 data/server.log，pid 在 data/server.pid
./scripts/stop.sh         # 停止背景實例
```

環境變數（可寫在 `.env`）：

| 變數 | 說明 |
|---|---|
| `PORT` | 埠號，預設 `3410`（只綁定 `127.0.0.1`） |
| `TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` | TDX 金鑰；未設定則用模擬資料 |
| `DATA_SOURCE` | 設為 `mock` 可強制使用模擬資料 |

API：`GET /api/lanes?dir=N|S`（伺服器記憶體快取 45 秒），`GET /api/health`。

## 測試

```bash
npm test        # 單元測試（node --test）：推估公式、建議遲滯、adapter、HTTP
npm run e2e     # Playwright（chromium，iPhone 13 尺寸），自動在 3411 埠以模擬資料啟動伺服器
```

E2E 截圖存放於 `test-results/screens/*.png`。若尚未安裝瀏覽器：`npx playwright install chromium`。

PNG 圖示由 `web/icons/icon.svg` 產生：`node scripts/make-icons.js`。

## 專案結構

```
server/index.js         node:http 伺服器（靜態檔 + API）
server/service.js       資料來源選擇、60 秒快取、TDX 失敗回報 unavailable
server/estimate.js      推估純函式（彙整、前方車輛、慢車、建議含遲滯）
server/adapters/mock.js 模擬資料（隨時間變化、右線偶有慢速大車車隊）
server/adapters/tdx.js  TDX OAuth2 + VD 即時資料（南北共用一次呼叫）
scripts/verify-tdx.js   TDX 即時資料驗證＋與前次紀錄比對
tests/fixtures/         實錄 TDX VDLive 樣本（無金鑰）
config/tunnel-vd.json   隧道 VD 選取設定（待核對）
web/                    前端（index.html、app.js、style.css、explain.html、manifest、圖示）
tests/unit, tests/e2e   測試
```

## 授權

MIT License，見 [LICENSE](LICENSE)。
