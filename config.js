// ====== 這個檔案的三個設定都要換成你自己的 ======
// （這些值放在 GitHub 公開沒關係，安全性靠 Worker 驗證與 firestore.rules）

// 1. Firebase：Firebase Console → 專案設定 → 一般 → 你的應用程式 → SDK 設定與配置
export const firebaseConfig = {
  apiKey: "AIzaSyBggeQbpz_JWJec0MUaY7LskYHv1VnfPc0",
  authDomain: "skate-cb461.firebaseapp.com",
  projectId: "skate-cb461",
  storageBucket: "skate-cb461.firebasestorage.app",
  messagingSenderId: "576689051214",
  appId: "1:576689051214:web:06792586ec3c066510151f",
  measurementId: "G-SF5JD6P0ZL"
};

// 2. LIFF ID：LINE Developers → 你的 LINE Login Channel → LIFF 分頁
export const LIFF_ID = "2012318362-VOU7aFr9";

// 3. Cloudflare Worker 網址（部署 worker.js 後取得，結尾不要加 /）
export const WORKER_URL = "https://punch-auth.eurekateamstar.workers.dev";
