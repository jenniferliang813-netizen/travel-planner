# 旅行計畫網頁：公開交班單

> **這份會公開在 GitHub 上**，只寫程式架構與規則，**不放任何私人行程內容、旅伴資料、文件 ID、金鑰**。
> 完整交班單 `AGENTS.md` 只存在使用者的電腦上（已 gitignore）。在雲端（claude.ai/code、手機）開 session 時讀這份就好。

## 使用者

- 梁婷瑋醫師，**一律用繁體中文（台灣用語）**回覆；程式碼、變數、註解用英文。
- 她是程式新手：修改說明要具體到操作層級，結論先講。
- 重大功能先討論、確認後再寫。

## 這是什麼

給使用者與旅伴共用的旅行計畫網頁：五個頁籤（航班交通／行李＋採購清單／行程大綱＋地圖／每日行程表格＋天氣／多人記帳）。一個網站管多趟旅行。**日常內容全部在網頁上編輯（手機也行），不需要 AI。**

## 架構

- 純前端：`index.html` + `style.css` + `app.js`，**沒有 build、沒有 node_modules**。
- 上線：GitHub Pages（main branch / root）。**push 到 main＝部署**，等 1–2 分鐘。
- 資料：Firebase Firestore（collection `trips`，一趟旅行＝一份 document）＋匿名登入。`firebase-config.js` 的 apiKey 設計上公開。
- 地圖：Leaflet（CDN）＋CARTO 圖磚；地點連結開 Google Maps／Naver Map。都不需金鑰，**不要改成需要金鑰的官方 Maps API**。
- 天氣：打開「每日行程」時向 Open-Meteo 即時抓（免金鑰），依座標選當地氣象局模型（日本 JMA、韓國 KMA、愛爾蘭/荷蘭/比利時 KNMI HARMONIE）。地點＝當天手動指定的 `day.wx`，否則用 `route` 裡 `d` 含這天（「Day 2-6」格式）的點。
- `worker/`：Cloudflare Worker 唯讀 API（秘密在 Cloudflare secrets，不在 repo）。

## 改程式必守的規則

1. **改了 `app.js` 或 `style.css`，要把 `index.html` 裡兩個 `?v=N` 一起 +1**，否則瀏覽器和 GitHub Pages 會給舊快取。
2. 改完跑 `node --check app.js`（語法檢查）。
3. 資料更新用點路徑 patch：`store.updateTrip(id, {"luggage.<id>.checked": {...}})`。**map 的 key 一律用 `uid()` 產生的英數 id，絕不拿人名或中文當 key**（Firestore field path 會壞）。人名只放在值裡。
4. 刪欄位用 `DELETE` 哨兵，值是 `" __DELETE__"`，**開頭那個空格是刻意的，別「修正」它**。
5. 寫入失敗靠全域 `unhandledrejection` alert 提示，新增寫入時不用各自包 try/catch。
6. 舊旅行可能缺某些欄位（`stays`、`shopping`、`phases`、`route`…），渲染時都要能處理「沒有這個欄位」。
7. 新功能的樣式要支援深色模式（`@media (prefers-color-scheme: dark)`）和 375px 手機寬度不橫向溢出。

## 在雲端／手機 session 的限制

- **只改程式碼，不要動真實行程資料**：雲端 session 沒有登入後的瀏覽器，也不該直接寫 Firestore。資料的修改請使用者在網頁上自己改（行程、簡圖點、天氣地點、待辦、記帳都有編輯介面）。
- **這個 repo 是公開的**：commit 前確認沒有私人行程內容、旅伴個資、Firestore 文件 ID、Worker 金鑰。
- 部署流程：改檔 → `?v=` +1 → `node --check app.js` → commit → push main → 請使用者 1–2 分鐘後重新整理確認。
- 回到電腦後，若有重要變更，記得同步寫進本機的 `AGENTS.md`。
