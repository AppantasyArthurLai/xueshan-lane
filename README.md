# 雪隧車道 xueshan-lane

國道5號雪山隧道「左線還是右線？」的小工具。根據隧道內車輛偵測器（VD）的即時資料，**推估**左線（內側）與右線（外側）的平均車速、前方車輛數與慢車疑似數量，並給出一個大大的建議：**建議走左線／建議走右線／兩線差不多**。可切換 **北上（往台北）／南下（往宜蘭）**，手機一眼看懂。

> ⚠ **非官方專案**，與任何既有服務、網站、App 或政府機關皆無關。
> ⚠ 畫面上**所有數值皆為推估**，不是實際數到的車輛數，可能有誤差，僅供參考。
> 🚫 **安全第一：請勿在駕駛中操作手機。** 請在出發前或由乘客查看；雪山隧道內禁止變換車道，請在進隧道前依現場標誌決定車道。

## 資料來源

- 交通部「TDX 運輸資料流通服務」高速公路 VD 即時資料（車道層級：車速、佔有率、車流量）與 VD 靜態資料。
- 未設定 TDX 金鑰時，自動使用**模擬資料**（畫面會明確標示「模擬資料」）。TDX 連線失敗時也會暫時退回模擬資料，API 回應中 `source` 為 `"mock-fallback"`。

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

### ⚠ 取得金鑰後需要核對的設定：`config/tunnel-vd.json`

隧道內偵測器的挑選是設定驅動的，目前的值（`"verified": false`）是依公開資訊推定，**尚未以實際資料驗證**：

- `roadId` / `roadNameIncludes` / `vdidIncludes`：判斷國道5號的條件（任一符合即可）。
- `mileageRangeKm`：隧道里程範圍（約 15K～28K，坪林至頭城）。
- `directions`：TDX 方向代碼對應北上／南下。
- `laneMap`：TDX `LaneID` 對應左線／右線（目前假設 `0`=內側=左線、`1`=右線）。
- `explicitVDIDs`：若要精確指定偵測器，直接在 `N` / `S` 填入 VDID 清單，會優先於里程篩選。
- `sampleIntervalSec`：VD 回報週期（用來把每次車輛數換算成每小時流量）。

建議拿到金鑰後，實際呼叫 VD 靜態資料確認國道5號隧道段的 VDID、里程與車道編號，再把 `verified` 改為 `true`。

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
server/service.js       資料來源選擇、快取、TDX 失敗退回模擬
server/estimate.js      推估純函式（彙整、前方車輛、慢車、建議含遲滯）
server/adapters/mock.js 模擬資料（隨時間變化、右線偶有慢速大車車隊）
server/adapters/tdx.js  TDX OAuth2 + VD 即時／靜態資料
config/tunnel-vd.json   隧道 VD 選取設定（待核對）
web/                    前端（index.html、app.js、style.css、explain.html、manifest、圖示）
tests/unit, tests/e2e   測試
```

## 授權

MIT License，見 [LICENSE](LICENSE)。
