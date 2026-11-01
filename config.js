// ====== 這個檔案的三個設定都要換成你自己的 ======
// （這些值放在 GitHub 公開沒關係，安全性靠 Worker 驗證與 firestore.rules）

// 1. Firebase：Firebase Console → 專案設定 → 一般 → 你的應用程式 → SDK 設定與配置
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxx"
};

// 2. LIFF ID：LINE Developers → 你的 LINE Login Channel → LIFF 分頁
export const LIFF_ID = "0000000000-xxxxxxxx";

// 3. Cloudflare Worker 網址（部署 worker.js 後取得，結尾不要加 /）
export const WORKER_URL = "https://punch-auth.你的帳號.workers.dev";
