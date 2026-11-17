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
- 地圖：Leaflet（CDN）＋OpenStreetMap 標準圖磚（2026-10 起 CARTO 圖磚要 API key、會顯示「API KEY REQUIRED」浮水印，已棄用）；地點連結開 Google Maps／Naver Map。都不需金鑰，**不要改成需要金鑰的官方 Maps API**。
- 天氣：打開「每日行程」時向 Open-Meteo 即時抓（免金鑰），依座標選當地氣象局模型（日本 JMA、韓國 KMA、愛爾蘭/荷蘭/比利時 KNMI HARMONIE）。地點＝當天手動指定的 `day.wx`，否則用 `route` 裡 `d` 含這天（「Day 2-6」格式）的點。
- 吃喝／採購小圖：行李頁有「🍴 吃喝」分頁（`trip.food`：市場／特色菜／當地酒，依城市分組）；採購清單可附小圖、Google Maps 地點與「帶回台灣額度」（`trip.carry`）。有填 `dayId` 的項目會在行程大綱那天列出關鍵字。小圖放 `img/food/`（只用自由授權圖，來源寫進 `img/food/CREDITS.md`，不要熱連外部圖片）。
- 各地交通：航班交通頁的「🚌 各地交通」卡（`trip.transit`）。
- 收合規則（v=22）：每日行程裡 `status: "weather backup"` 的列不放主表，收進表格下方「🌦️ 天氣備案」可展開區；住宿卡（`trip.stays`）某個 group 的每一筆都是 `cancel`（待取消）或 `dropped` 時，整組預設收合。住宿狀態另有 `primary`（主方案）。同時間（或沒填時間）的行程列依 id 排序。
- 貼文連結（v=26）：吃喝項目可填 `link`（顯示「🔗 貼文」）；備註卡內文裡的 http(s) 網址會自動變成可點連結。
- 備註卡（v=25）：`trip.notes` 某筆加 `tone: "muted"` 會顯示成灰底中性卡（用來放「目前不採用」的備案路線）；在網頁編輯該則時會保留 `tone`。
- 頁內切換（v=27）：行程大綱頁有四個切換鈕（`view.outlineTab`：行程／待辦／備註／住宿），待辦、備註、住宿不再排在每日大綱下方；已勾選的待辦收進「✅ 已完成」摺疊區；行程頁最上面一行顯示下一件未完成待辦。行李頁的行李／採購／吃喝切換會記在該裝置（`localStorage["tp-bagtab-<tripId>"]`），沒記錄時旅途中預設採購、其餘預設行李。旅途中「每日行程」預設選今天、大綱頁自動捲到今天的日卡。
- 瀏覽／編輯模式（v=28）：預設是**瀏覽模式**（`body.view-mode`，CSS 藏起 `.edit-btn`／`.mini-btn`／`.fab`／每日行程表最後一欄），右上角「✏️ 編輯」才出現新增／修改／刪除入口，選擇記在該裝置 `localStorage["tp-edit"]`。瀏覽模式仍可用：行李／採購／待辦勾選、記帳（`.fab.keep-view`）、分享（`.edit-btn.keep-view`）。**新增任何編輯入口請沿用 `.edit-btn`／`.mini-btn`／`.fab` 這三個 class**，瀏覽模式才會自動藏；要在瀏覽模式保留的加 `keep-view`。
- 離線（v=28）：(1) Firestore 開了本機持久快取（`persistentLocalCache`），看過的旅行沒網路也讀得到，離線時的勾選／記帳會排隊、恢復網路自動上傳；`updateTrip` 最多等伺服器 2 秒就放行（山區「有格沒網路」時不會卡住視窗）。(2) `sw.js`（service worker）快取網頁檔、Firebase／Leaflet 程式庫、`img/` 圖片、看過的地圖圖磚；開頁先等網路 2.5 秒，等不到就用存下來的版本。**`sw.js` 不含版本號**，安裝時自己讀 `index.html` 找目前的 `?v=N`，所以改版仍然只要改 `index.html` 的兩個 `?v=N`。(3) 沒網路（`navigator.onLine === false`）時強制瀏覽模式、右上角顯示「📴 離線」。天氣與地點搜尋需要網路。
- 加到主畫面（v=28）：`manifest.webmanifest`＋`icons/`（由本機腳本產生的 PNG）。manifest **刻意不寫 `start_url`**，這樣旅伴從 `?trip=<id>` 分享連結加到主畫面時會保留該連結；另有 `localStorage["tp-locked-trip"]` 備援（只在主畫面 App 模式下採用）。
- 封面頁（v=29）：進旅行後的第一個畫面是 `#/t/<id>/home`（頁籤列最左邊「🏠 封面」；不認得的頁籤名稱也會落到這裡）。內容＝封面照（`trip.cover = {img, credit}`，選填；沒有就用主題色）＋「查看今日行程」大按鈕＋今天（或出發前的 Day 1）前 4 項行程＋航班／住宿／待辦／清單四顆捷徑。封面照放 `img/cover/`，只用自由授權圖，來源寫進 `img/cover/CREDITS.md`。
- 每日行程手機卡片（v=29）：`schedTable()` 同時輸出卡片（`.sched-cards`，`schedCard()`）與表格（`.table-wrap.sched-wrap`），CSS 在 699px 以下顯示卡片、以上顯示表格。**改每日行程的欄位時兩邊都要改。** 卡片有 `place` 才出現整排寬的「🧭 地圖導航」。
- `worker/`：Cloudflare Worker 唯讀 API（秘密在 Cloudflare secrets，不在 repo）。

## 改程式必守的規則

1. **改了 `app.js` 或 `style.css`，要把 `index.html` 裡兩個 `?v=N` 一起 +1**，否則瀏覽器和 GitHub Pages 會給舊快取。
2. 改完跑 `node --check app.js`（語法檢查）。
3. 資料更新用點路徑 patch：`store.updateTrip(id, {"luggage.<id>.checked": {...}})`。**map 的 key 一律用 `uid()` 產生的英數 id，絕不拿人名或中文當 key**（Firestore field path 會壞）。人名只放在值裡。
4. 刪欄位用 `DELETE` 哨兵，值是 `" __DELETE__"`，**開頭那個空格是刻意的，別「修正」它**。
5. 寫入失敗靠全域 `unhandledrejection` alert 提示，新增寫入時不用各自包 try/catch。
6. 舊旅行可能缺某些欄位（`stays`、`shopping`、`phases`、`route`…），渲染時都要能處理「沒有這個欄位」。
7. **只有淺色模式**（使用者 2026-09-23 決定拿掉深色；`:root` 設 `color-scheme: light`），**不要再加 `prefers-color-scheme: dark`**。新樣式要在 375px 手機寬度不橫向溢出。

## 在雲端／手機 session 的限制

- **只改程式碼，不要動真實行程資料**：雲端 session 沒有登入後的瀏覽器，也不該直接寫 Firestore。資料的修改請使用者在網頁上自己改（行程、簡圖點、天氣地點、待辦、記帳都有編輯介面）。
- **這個 repo 是公開的**：commit 前確認沒有私人行程內容、旅伴個資、Firestore 文件 ID、Worker 金鑰。
- 部署流程：改檔 → `?v=` +1 → `node --check app.js` → commit → push main → 請使用者 1–2 分鐘後重新整理確認。
- 回到電腦後，若有重要變更，記得同步寫進本機的 `AGENTS.md`。
