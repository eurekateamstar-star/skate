# ⏱ 打卡系統（LINE 登入版）

HTML + JavaScript + Firebase，網頁放 GitHub Pages，LINE 身分驗證交給 Cloudflare Worker（免費）。

```
員工手機 ──LINE 登入──▶ 網頁(GitHub Pages) ──LINE token──▶ Cloudflare Worker
                                 ▲                         │ 向 LINE 驗證身分
                                 └──── Firebase 登入 ◀──────┘ 查員工綁定
```

## 綁定流程
1. 管理者在「員工管理」建立員工（姓名、員編、Email）
2. 員工用 LINE 登入 → 第一次會看到員工名單 → 點自己的名字 → 輸入 Email
3. Email 對上就綁定完成，之後用 LINE 登入就直接進入打卡畫面
4. Email 輸錯 5 次會鎖定；換手機 / 換 LINE 帳號時，管理者按「解除綁定」即可重新綁定

## 檔案

| 檔案 | 放哪裡 |
|---|---|
| `index.html`、`style.css`、`app.js`、`config.js` | **GitHub**（網站本體，`config.js` 要先填好） |
| `worker.js` | **Cloudflare Worker**（貼到 Worker 程式碼編輯器） |
| `firestore.rules` | **Firebase Console → Firestore → 規則** |
| `README.md` | GitHub（說明文件） |

> `worker.js` 放在 GitHub 也沒關係（裡面沒有密碼），但它是在 Cloudflare 執行的。

---

## 設定步驟

### 1. Firebase
1. <https://console.firebase.google.com> → 新增專案
2. **Authentication → 開始使用**（不需要啟用任何登入方式，LINE 登入走自訂 token）
3. **Firestore Database → 建立資料庫**（地區建議 `asia-east1`）→ **規則** 分頁貼上 `firestore.rules` → 發布
4. **專案設定 → 一般 → 你的應用程式** → 新增網頁應用程式 `</>` → 複製 `firebaseConfig` 貼到 `config.js`
5. **專案設定 → 服務帳戶 → 產生新的私密金鑰** → 下載 JSON（等一下給 Worker 用，**不要放上 GitHub**）

### 2. 建立第一位管理者（只做一次）
Firestore → **開始集合** → 集合 ID 填 `employees` → 文件 ID 按「自動產生」→ 新增欄位：

| 欄位 | 類型 | 值 |
|---|---|---|
| `name` | string | 你的名字 |
| `empNo` | string | 例如 `BOSS` |
| `email` | string | 你的 Email（小寫） |
| `role` | string | `admin` |
| `active` | boolean | `true` |
| `lineUid` | null | |
| `bindFails` | number | `0` |

之後的員工都在網站「員工管理」新增即可。

### 3. LINE Developers
1. <https://developers.line.biz/console/> → 建立 Provider → 建立 **LINE Login** Channel
   （App types 勾 **Web app**）
2. Basic settings 記下 **Channel ID**
3. **LIFF** 分頁 → Add：
   - Size：`Full`
   - Endpoint URL：`https://eurekateamstar-star.github.io/skate/`
   - Scopes：勾 `openid`、`profile`
   - 記下 **LIFF ID** → 貼到 `config.js`
4. Channel 狀態從「Developing」改成 **Published**
   （開發中只有你自己和測試者能登入，員工會登不進來）

### 4. Cloudflare Worker
1. <https://dash.cloudflare.com> → **Workers & Pages → 建立 → Worker** → 取名 `punch-auth` → 部署
2. **編輯程式碼** → 刪掉原本內容，貼上 `worker.js` → **部署**
3. **設定 → 變數和密碼** → 新增：

| 名稱 | 類型 | 值 |
|---|---|---|
| `LINE_CHANNEL_ID` | 文字 | LINE Login Channel ID |
| `FIREBASE_PROJECT_ID` | 文字 | 服務帳戶 JSON 的 `project_id` |
| `FIREBASE_CLIENT_EMAIL` | 文字 | 服務帳戶 JSON 的 `client_email` |
| `FIREBASE_PRIVATE_KEY` | **密碼** | 服務帳戶 JSON 的 `private_key`（整串，含 `-----BEGIN…` 與 `\n`） |
| `ALLOWED_ORIGIN` | 文字 | `https://eurekateamstar-star.github.io` |

4. 複製 Worker 網址（`https://punch-auth.xxx.workers.dev`）→ 貼到 `config.js` 的 `WORKER_URL`

### 5. GitHub Pages
把 `index.html`、`style.css`、`app.js`、`config.js`（和 `README.md`）上傳到儲存庫最外層 →
**Settings → Pages** → Branch `main` / `(root)` → Save。

### 6. 測試
1. 手機用 LINE 打開 `https://liff.line.me/你的LIFF_ID`（或直接開 GitHub Pages 網址）
2. 用管理者帳號綁定（點自己的名字、輸入 Email）
3. 進入後到「班別設定」建班別、「員工管理」加員工、「排班作業」排班

> 小技巧：把 `https://liff.line.me/你的LIFF_ID` 放到 LINE 官方帳號的圖文選單，員工點一下就能打卡。

---

## 資料結構（Firestore）
```
employees/{empId}        name, empNo, email, role, active, lineUid, lineName, linePicture, bindFails
shiftTypes/{id}          cat('shift'|'leave'), name, start, end, color, order
schedules/{empId_日期}    empId, date, month, shiftIds[]
attendance/{id}          empId, name, empNo, type('in'|'out'), date, month, ts(伺服器時間), lat, lng
```
所有查詢只用「等於」條件，不需要建立複合索引。

## 安全性
- LINE 身分由 Worker 向 LINE 伺服器驗證，前端無法偽造
- 綁定時的 Email 比對在 Worker 進行，員工看不到別人的 Email
- 打卡一律用 Firebase 伺服器時間，員工不能修改或刪除紀錄
- 管理者解除綁定或停用員工後，對方立即失去存取權

## 常見問題
- **一直跳回 LINE 登入**：檢查 LIFF Endpoint URL 是否和網址完全一致（含結尾 `/`）
- **登入失敗 server_error**：多半是 Worker 變數設錯，到 Worker →「記錄」查看錯誤訊息
- **權限不足**：確認 `firestore.rules` 已發布，且員工資料的 `active` 不是 `false`
