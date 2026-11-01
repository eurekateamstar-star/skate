# ⏱ 打卡系統（HTML + JavaScript + Firebase）

純前端的打卡 / 排班系統，資料存在 Firebase Firestore，網頁放在 GitHub Pages，不需要自己的伺服器。

## 功能

**員工**
- 上班 / 下班打卡（使用伺服器時間，可記錄 GPS 位置）
- 查看當月出勤紀錄（工時、遲到、早退、缺卡）
- 月曆檢視自己的班表

**管理者**
- 員工管理：修改員編、姓名、權限
- 班別設定：班別（含上下班時間）與休假類別，自訂顏色
- 排班作業：員工 × 日期表格，點選班別再點格子排班、× 移除、複製上月
- 出勤報表：月統計、每日明細、下載 CSV（Excel 可直接開）

## 檔案

| 檔案 | 說明 |
|---|---|
| `index.html` | 頁面 |
| `style.css` | 樣式 |
| `app.js` | 程式邏輯 |
| `firebase-config.js` | **填入你的 Firebase 設定** |
| `firestore.rules` | 資料庫安全規則（貼到 Firebase Console） |

---

## 安裝步驟

### 1. 建立 Firebase 專案
1. 到 <https://console.firebase.google.com> → 新增專案
2. **Authentication** → 開始使用 → 登入方式 → 啟用「電子郵件/密碼」
3. **Firestore Database** → 建立資料庫 → 選地區（建議 `asia-east1` 台灣）→ 正式版模式
4. Firestore → **規則** 分頁 → 把 `firestore.rules` 的內容整份貼上 → 發布
5. 專案設定（齒輪）→ 一般 → 你的應用程式 → 點 `</>` 新增網頁應用程式 → 複製 `firebaseConfig`

### 2. 填入設定
打開 `firebase-config.js`，把 `firebaseConfig` 換成剛剛複製的內容。

> 這組設定公開在 GitHub 上是正常的，資料安全由 `firestore.rules` 保護。

### 3. 上傳到 GitHub 並開啟 Pages
```bash
git init
git add .
git commit -m "打卡系統"
git branch -M main
git remote add origin https://github.com/你的帳號/punch-clock.git
git push -u origin main
```
GitHub 儲存庫 → **Settings → Pages** → Source 選 `Deploy from a branch` → Branch 選 `main` / `(root)` → Save。
約 1 分鐘後網址會是：`https://你的帳號.github.io/punch-clock/`

### 4. 授權網域
Firebase → Authentication → **設定 → 授權網域** → 新增 `你的帳號.github.io`

### 5. 設定第一位管理者
1. 打開網站，用「註冊」建立你自己的帳號
2. Firebase → Firestore → `users` 集合 → 找到你的文件 → 把 `role` 從 `employee` 改成 `admin`
3. 重新整理網頁，左側就會出現「管理者專區」。之後其他人可以直接在「員工管理」裡設定權限。

### 6. 開始使用
1. 管理者到「班別設定」建立班別（例：早班 08:00~17:00）與休假（國定假日、例假日…）
2. 請員工自行註冊
3. 到「排班作業」排班
4. 員工登入即可打卡

---

## 資料結構（Firestore）

```
users/{uid}            name, empNo, email, role('admin'|'employee')
shiftTypes/{id}        cat('shift'|'leave'), name, start, end, color, order
schedules/{uid_日期}    uid, date('2026-12-01'), month('2026-12'), shiftIds[]
attendance/{id}        uid, name, empNo, type('in'|'out'), date, month, ts(伺服器時間), lat, lng
```

所有查詢都只用「等於」條件，**不需要另外建立複合索引**。

## 本機測試
ES Module 不能直接雙擊 html 開啟，請用本機伺服器：
```bash
npx serve .
# 或
python -m http.server 8000
```
並在 Firebase 授權網域確認有 `localhost`（預設已有）。

## 注意事項
- GPS 需要 HTTPS（GitHub Pages 已是 HTTPS），手機瀏覽器第一次會詢問定位權限。
- 打卡時間使用 Firebase 伺服器時間，員工改手機時間無效；規則也禁止員工修改或刪除打卡紀錄。
- 若要限制只能在公司附近打卡，可在 `app.js` 的 `punch()` 裡加入距離判斷（前端限制，可再搭配 Cloud Functions 加強）。
