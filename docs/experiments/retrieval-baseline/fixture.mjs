// Deterministic synthetic fixture for the retrieval baseline.
//
// Fictional project: "Tidewater" 渡輪訂位系統 (a ferry booking backend). Every name, port, vessel and payment
// gateway ("PayStub") is invented; nothing here comes from this repository or any real organisation.
//
// seedFixture(store, root) builds the whole project in an empty store: Sessions with continues/related chains,
// Knowledge (active, superseded, archived, needsReview), one voided Session and Knowledge pages. Every entity has a
// stable fixture key (its idempotency key); the returned `ids` object maps key -> real id.
// Time is controlled by an installed fake clock, so the data (and therefore every read) is reproducible.
// ---------------------------------------------------------------------------------------------------------------
// Fake clock: Date.now() and `new Date()` return a value we set; everything else behaves like Date.
// ---------------------------------------------------------------------------------------------------------------
const RealDate = Date;
let fakeNow = null;
class FixtureDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && fakeNow !== null) super(fakeNow);
    else super(...args);
  }
  static now() {
    return fakeNow ?? RealDate.now();
  }
}

export const clock = {
  install() {
    globalThis.Date = FixtureDate;
  },
  restore() {
    globalThis.Date = RealDate;
    fakeNow = null;
  },
  set(iso) {
    fakeNow = RealDate.parse(iso);
  },
  advance(minutes) {
    fakeNow += minutes * 60_000;
  },
  get iso() {
    return new RealDate(fakeNow ?? RealDate.now()).toISOString();
  },
};

export const FIXTURE_START = "2026-03-02T01:00:00.000Z";

// ---------------------------------------------------------------------------------------------------------------
// Fixture definition. Order matters: it is the project timeline.
// ---------------------------------------------------------------------------------------------------------------
const session = (key, title, summary, fields = {}) => ({ op: "session", key, title, summary, ...fields });
const knowledge = (key, session, kind, title, body, fields = {}) => ({
  op: "knowledge",
  key,
  session,
  kind,
  title,
  body,
  ...fields,
});

export const STEPS = [
  // --- 座位保留 chain starts, fare chain starts ---
  session("s.hold-mem", "以記憶體 Map 實作座位暫時保留", "新增 HoldStore，旅客選位後以記憶體 Map 暫存保留，TTL 10 分鐘，逾時釋放。", {
    outcomes: ["HoldStore 以 Map<seatId, Hold> 保存保留，TTL 為 10 分鐘", "選位 API 回傳 holdId 與到期時間，前端倒數顯示"],
    decisions: ["第一版以單一程序記憶體保存保留，先求能跑通訂位流程"],
    next: ["確認多個 API 實例時保留是否一致", "補上保留逾時的單元測試"],
    files: ["src/holds/hold-store.ts", "src/api/seats.ts"],
  }),
  session("s.fare-hardcode", "票價規則先以常數表實作", "以 FARES 常數表寫死成人、兒童、長者三種票價，先支援單一航線。", {
    outcomes: ["FARES 常數表包含成人、兒童、長者三種旅客類型", "訂位流程可依航線計算總價"],
    decisions: ["票價先寫在程式碼內，等航線增加再外部化"],
    next: ["新增航線時需要改程式碼，之後改成資料表"],
    files: ["src/fares/fares.ts"],
  }),
  session("s.hold-db", "座位保留改存資料庫 holds 表", "服務重啟後記憶體保留全部消失，旅客付款時座位已被他人買走；改存資料庫 holds 表。", {
    parent: "s.hold-mem",
    outcomes: ["新增 holds 資料表（seat_id、booking_id、expires_at）取代記憶體 Map", "重啟服務後保留仍然有效，已以整合測試驗證"],
    decisions: ["座位保留存放在資料庫 holds 表，不放記憶體，原因是重啟會遺失且多個 API 實例之間不共享"],
    next: ["過期保留需要定期清理，下一步處理"],
    files: ["src/holds/hold-repository.ts", "db/migrations/003_holds.sql"],
  }),
  knowledge("k.hold-db", "s.hold-db", "decision", "座位保留存資料庫 holds 表，不用記憶體", "座位暫時保留一律存放在資料庫 holds 表（seat_id、booking_id、expires_at）。不可只放在程序記憶體：服務重啟會遺失保留，多個 API 實例也不會共享，旅客付款時可能發現座位已被他人買走。", {
    tags: ["holds", "座位保留", "資料庫"],
    appliesTo: ["src/holds/**"],
  }),
  session("s.ci-setup", "建立 CI 流程與 lint 規則", "新增 CI 工作流程：安裝、lint、單元測試，並訂定 lint 規則。", {
    outcomes: ["CI 在每次推送執行 lint 與單元測試", "lint 規則禁止 console.log 與未使用變數"],
    decisions: [],
    next: ["之後加入整合測試用的資料庫容器"],
    files: [".ci/pipeline.yml", "eslint.config.js"],
  }),
  session("s.fare-table", "票價改為 fare_rules 資料表", "新增 fare_rules 資料表，以航線與旅客類型決定基本價，移除常數表。", {
    parent: "s.fare-hardcode",
    outcomes: ["fare_rules 資料表（route_id、passenger_type、base_price）上線", "舊的 FARES 常數表已移除，資料以遷移腳本匯入"],
    decisions: ["票價規則改存資料表，新增航線不需改程式碼"],
    next: ["旺季需要加成，下一步設計"],
    files: ["src/fares/fare-repository.ts", "db/migrations/004_fare_rules.sql"],
  }),
  session("s.tz-bug", "修正航班時間時區顯示錯誤", "航班出發時間在前端顯示晚了 8 小時；根因是以本地時間存入資料庫。", {
    outcomes: ["航班時間改以 UTC 儲存，顯示時才轉為港口時區", "補上跨日航班的時區單元測試"],
    decisions: ["航班時間一律存 UTC，顯示層依港口時區轉換"],
    next: ["檢查通知簡訊中的時間是否也要轉換"],
    files: ["src/flights/time.ts", "src/web/format-time.ts"],
  }),
  knowledge("k.tz-utc", "s.tz-bug", "gotcha", "航班時間一律存 UTC", "航班出發與抵達時間必須以 UTC 儲存，顯示時才依港口時區轉換。以本地時間存入曾造成前端顯示晚 8 小時，跨日航班尤其容易出錯。", {
    tags: ["時區", "航班時間"],
    appliesTo: ["src/flights/**"],
  }),
  session("s.hold-sweeper", "以 60 秒排程 sweeper 清理過期保留", "新增 sweeper 每 60 秒掃描 holds 表，刪除 expires_at 已過的保留。", {
    parent: "s.hold-db",
    outcomes: ["HoldSweeper 每 60 秒執行一次，刪除過期保留並釋放座位", "清理動作寫入結構化日誌，方便追蹤釋放數量"],
    decisions: ["以每 60 秒的排程 sweeper 清理過期保留"],
    next: ["觀察 sweeper 與付款流程是否會同時修改同一筆保留"],
    files: ["src/holds/sweeper.ts"],
  }),
  knowledge("k.sweeper", "s.hold-sweeper", "decision", "以 60 秒排程 sweeper 清理過期保留", "過期的座位保留由 HoldSweeper 每 60 秒掃描 holds 表清理，不在請求路徑上處理過期。", {
    tags: ["holds", "sweeper", "過期"],
    appliesTo: ["src/holds/sweeper.ts"],
  }),
  session("s.peak", "加入旺季加成 peak surcharge", "票價加入旺季加成：7 至 8 月與春節期間加成 15%，日期由 peak_calendar 判斷。", {
    parent: "s.fare-table",
    outcomes: ["旺季加成為 15%，涵蓋 7 至 8 月與春節連假", "peak_calendar 資料表由營運人員維護"],
    decisions: ["旺季加成比例為 15%，期間以 peak_calendar 為準"],
    next: ["確認折扣與旺季加成的疊加順序"],
    files: ["src/fares/surcharge.ts", "db/migrations/005_peak_calendar.sql"],
  }),
  session("s.pay-sandbox", "接入 PayStub 付款沙盒", "串接 PayStub 沙盒環境，可建立 charge 並取得付款結果。", {
    outcomes: ["PayStubClient 可在沙盒建立 charge 與查詢狀態", "測試卡號情境（成功、拒絕、逾時）已整理成測試資料"],
    decisions: ["付款閘道先接 PayStub，抽象成 PaymentGateway 介面以便日後替換"],
    next: ["回呼（webhook）需要驗證簽章"],
    files: ["src/payments/paystub-client.ts", "src/payments/gateway.ts"],
  }),
  session("s.waitlist-basic", "候補名單基本功能", "額滿航班可加入候補名單，退票釋出座位時可被遞補。", {
    outcomes: ["新增 waitlist_entries 資料表與加入、取消候補 API", "額滿航班頁面顯示候補入口"],
    decisions: [],
    next: ["遞補時要通知旅客", "候補順位的規則尚未決定"],
    files: ["src/waitlist/waitlist-service.ts", "db/migrations/006_waitlist.sql"],
  }),
  session("s.fare-order", "修正折扣與旺季加成疊加順序", "旺季期間使用優惠券時多收了金額；釐清並固定票價計算順序。", {
    parent: "s.peak",
    outcomes: ["票價計算順序固定為基本價、折扣、旺季加成、稅", "新增 12 組旺季加優惠券的金額測試案例"],
    decisions: ["旺季加成以折扣後價格計算，才符合對外公告的票價"],
    next: ["考慮是否快取票價結果以降低查詢"],
    files: ["src/fares/calculate.ts", "tests/fares/calculate.test.ts"],
  }),
  knowledge("k.fare-order", "s.fare-order", "pattern", "票價計算順序：基本價、折扣、旺季加成、稅", "票價計算固定依序為：基本價、折扣、旺季加成、稅。旺季加成必須以折扣後價格計算；順序顛倒會造成金額與公告票價不一致，旺季使用優惠券時曾因此多收。", {
    tags: ["票價", "折扣", "旺季加成"],
    appliesTo: ["src/fares/calculate.ts"],
  }),
  session("s.pay-sig", "PayStub 回呼簽章驗證", "實作 webhook 簽章驗證：HMAC-SHA256，必須以原始 request body 計算。", {
    parent: "s.pay-sandbox",
    outcomes: ["webhook 端點驗證 X-PayStub-Signature，驗證失敗回 401", "簽章驗證以 raw body 計算，並附上重放攻擊的時間戳檢查"],
    decisions: ["簽章以原始 request body 計算 HMAC-SHA256，不可用解析後的 JSON 重新序列化"],
    next: ["付款請求需要冪等處理"],
    files: ["src/payments/webhook.ts", "src/api/raw-body.ts"],
  }),
  knowledge("k.webhook-sig", "s.pay-sig", "gotcha", "PayStub 回呼簽章須用原始 body 計算", "PayStub webhook 的 HMAC-SHA256 簽章必須用原始 request body 位元組計算。若先解析成 JSON 再重新序列化，欄位順序與空白改變，簽章會偶發驗證失敗。", {
    tags: ["paystub", "webhook", "簽章"],
    appliesTo: ["src/payments/webhook.ts"],
  }),
  session("s.manifest-csv", "艙單匯出 CSV 給港務局", "出發前匯出乘客與車輛艙單 CSV，欄位順序依港務局規格。", {
    outcomes: ["艙單 CSV 匯出，欄位順序依港務局公告規格", "匯出檔案名稱含航班代碼與日期"],
    decisions: ["艙單以 CSV 交付港務局，欄位順序固定不可調整"],
    next: ["車輛重量欄位的進位方式要確認"],
    files: ["src/manifest/export-csv.ts"],
  }),
  knowledge("k.csv-manifest", "s.manifest-csv", "pattern", "艙單以 CSV 匯出，欄位順序固定", "艙單以 CSV 匯出給港務局，欄位順序依港務局公告規格固定，不可自行調整欄位順序。", {
    tags: ["艙單", "csv", "港務局"],
    appliesTo: ["src/manifest/**"],
  }),
  session("s.hold-race", "修正付款回呼與保留過期的競態", "付款回呼與 sweeper 同時處理同一筆保留，已付款座位曾被釋放；holds 加上 version。", {
    parent: "s.hold-sweeper",
    related: ["s.pay-sig"],
    applied: ["k.hold-db"],
    outcomes: ["holds 新增 version 欄位，付款確認以 version 比對（樂觀鎖）", "重現競態的整合測試已加入，修正後不再釋放已付款座位"],
    decisions: ["付款確認必須帶 hold version，與過期清理競爭時以版本不符為準"],
    next: ["評估是否能從根本消除 sweeper 帶來的競態"],
    files: ["src/holds/hold-repository.ts", "src/payments/confirm.ts"],
  }),
  knowledge("k.hold-race", "s.hold-race", "gotcha", "付款確認須帶 hold version，避免與過期清理競態", "付款回呼確認座位時必須帶 hold version。沒有版本檢查時，付款回呼與過期清理同時處理同一筆保留，會把已付款的座位釋放給別人。", {
    tags: ["holds", "競態", "付款"],
    appliesTo: ["src/holds/**", "src/payments/confirm.ts"],
  }),
  session("s.notify-sms", "簡訊通知出發提醒", "出發前 24 小時與 2 小時各發一次簡訊提醒。", {
    outcomes: ["出發前 24 小時與 2 小時各寄一次簡訊提醒", "簡訊內容含航班代碼、港口與登船時間"],
    decisions: [],
    next: ["深夜發送簡訊可能擾民，需要靜音時段"],
    files: ["src/notify/sms.ts"],
  }),
  session("s.pay-idem", "付款請求冪等 key", "網路逾時重送造成重複扣款；付款請求加上冪等 key。", {
    parent: "s.pay-sig",
    outcomes: ["付款請求帶 idempotency key（bookingId 加 attempt 序號）", "沙盒測試重送同一請求只會扣款一次"],
    decisions: ["付款請求一律帶冪等 key，避免網路重送造成重複扣款"],
    next: ["付款失敗時的重試策略"],
    files: ["src/payments/paystub-client.ts"],
  }),
  knowledge("k.pay-idem", "s.pay-idem", "pattern", "付款請求一律帶冪等 key", "每次呼叫 PayStub 建立 charge 都必須帶冪等 key，格式為 bookingId 加 attempt 序號。網路逾時後重送同一請求，閘道只會扣款一次。", {
    tags: ["paystub", "冪等", "付款"],
    appliesTo: ["src/payments/paystub-client.ts"],
  }),
  session("s.fax-list", "乘客名單傳真給港務局", "出發前 2 小時自動將乘客名單傳真給港務局。", {
    outcomes: ["出發前 2 小時自動傳真乘客名單", "傳真失敗時寄信通知值班人員"],
    decisions: ["乘客名單以傳真交付港務局，出發前 2 小時送出"],
    next: ["傳真供應商的穩定度待觀察"],
    files: ["src/manifest/fax.ts"],
  }),
  knowledge("k.legacy-fax", "s.fax-list", "decision", "出發前 2 小時傳真乘客名單給港務局", "乘客名單於出發前 2 小時以傳真送交港務局，失敗時通知值班人員。", {
    tags: ["傳真", "港務局", "乘客名單"],
    appliesTo: ["src/manifest/fax.ts"],
  }),
  session("s.waitlist-notify", "候補遞補通知", "退票釋出座位時通知第一位候補，保留 15 分鐘等待確認。", {
    parent: "s.waitlist-basic",
    outcomes: ["退票釋出座位後通知第一位候補旅客", "候補確認期限為 15 分鐘，逾時遞補下一位"],
    decisions: ["遞補通知的確認期限為 15 分鐘"],
    next: ["候補順位的排序規則尚待決定"],
    files: ["src/waitlist/promote.ts"],
  }),

  // --- Knowledge pages written here: both read the same Session batch ---
  {
    op: "page",
    slug: "architecture",
    sections: [
      { heading: "座位保留", content: "座位保留存放在資料庫 holds 表，由 sweeper 每 60 秒清理過期保留。", sources: ["s.hold-db", "s.hold-sweeper"] },
      { heading: "票價", content: "票價規則存放在 fare_rules，旺季加成為 15%，期間由 peak_calendar 決定。", sources: ["s.fare-table", "s.peak"] },
      { heading: "付款", content: "付款透過 PaymentGateway 介面接入 PayStub，webhook 以 HMAC-SHA256 驗證簽章。", sources: ["s.pay-sandbox", "s.pay-sig"] },
      { heading: "候補", content: "額滿航班可加入候補，退票後通知第一位候補並保留 15 分鐘。", sources: ["s.waitlist-basic"] },
    ],
  },
  {
    op: "page",
    slug: "pitfalls",
    sections: [
      { heading: "時區", content: "航班時間一律存 UTC，顯示時才轉換為港口時區。", sources: ["s.tz-bug"] },
      { heading: "保留與過期清理", content: "sweeper 清理過期保留時要小心與付款流程同時操作同一筆保留。", sources: ["s.hold-sweeper"] },
      { heading: "名單交付", content: "乘客名單以傳真交付港務局，出發前 2 小時送出，失敗時通知值班人員。", sources: ["s.fax-list"] },
    ],
  },

  // --- later work: many more Sessions, so the pages above fall far behind ---
  session("s.notify-quiet", "通知夜間靜音時段", "深夜簡訊擾民客訴；22:00 至 06:00 不發送簡訊，延後到 06:00 之後。", {
    related: ["s.notify-sms"],
    outcomes: ["22:00 至 06:00 不發送簡訊，延後到 06:00 之後發送", "靜音時段依旅客所在港口時區判斷"],
    decisions: ["通知靜音時段為 22:00 至 06:00（港口時區），出發前 2 小時的提醒除外"],
    next: ["其他通知管道（電子郵件）不受靜音限制，之後再評估"],
    files: ["src/notify/quiet-hours.ts"],
  }),
  knowledge("k.notify-quiet", "s.notify-quiet", "pattern", "簡訊靜音時段 22:00 至 06:00", "簡訊在港口時區 22:00 至 06:00 不發送，延後到 06:00 之後；出發前 2 小時的提醒不受靜音限制。", {
    tags: ["通知", "簡訊", "靜音"],
    appliesTo: ["src/notify/**"],
  }),
  session("s.fare-cache", "票價結果快取至每日 04:00", "票價查詢量大，將計算結果快取，每日 04:00 失效。", {
    parent: "s.fare-order",
    outcomes: ["票價計算結果以航線與旅客類型為 key 快取", "快取每日 04:00 一次性失效"],
    decisions: ["票價結果快取到每日 04:00 失效，以降低資料庫查詢"],
    next: ["觀察快取命中率與旺季調價的互動"],
    files: ["src/fares/cache.ts"],
  }),
  knowledge("k.fare-cache", "s.fare-cache", "decision", "票價結果快取至每日 04:00", "票價計算結果快取到每日 04:00 失效，用來降低資料庫查詢量。", {
    tags: ["票價", "快取"],
    appliesTo: ["src/fares/cache.ts"],
  }),
  session("s.pay-retry", "付款失敗重試 3 次指數退避", "付款失敗時由伺服端重試 3 次，間隔 1、2、4 秒。", {
    parent: "s.pay-idem",
    applied: ["k.pay-idem"],
    outcomes: ["付款失敗自動重試 3 次，指數退避 1、2、4 秒", "重試時沿用同一個冪等 key"],
    decisions: ["付款失敗重試 3 次，採指數退避"],
    next: ["觀察 webhook 延遲時重試的行為"],
    files: ["src/payments/retry.ts"],
  }),
  knowledge("k.pay-retry", "s.pay-retry", "decision", "付款失敗重試 3 次指數退避", "付款失敗由伺服端自動重試 3 次，間隔 1、2、4 秒，重試沿用同一個冪等 key。", {
    tags: ["付款", "重試"],
    appliesTo: ["src/payments/retry.ts"],
  }),
  session("s.waitlist-fair", "候補依申請時間排序", "候補順位依申請時間先後（FIFO），不依艙等或會員等級。", {
    parent: "s.waitlist-notify",
    outcomes: ["候補順位以申請時間 FIFO 排序", "會員等級與艙等不影響候補順位"],
    decisions: ["候補依申請時間排序，不以艙等或會員等級加權，避免客服無法解釋差別待遇"],
    next: ["考慮候補名單人數上限"],
    files: ["src/waitlist/ordering.ts"],
  }),
  knowledge("k.waitlist-fifo", "s.waitlist-fair", "decision", "候補依申請時間 FIFO", "候補順位只依申請時間先後（FIFO），不依艙等或會員等級加權。原因是加權後客服無法向旅客解釋為何排在後面，曾引發客訴。", {
    tags: ["候補", "排序", "公平"],
    appliesTo: ["src/waitlist/**"],
  }),
  session("s.refund-48", "退票於出發 48 小時前全額退款", "訂定退票規則：出發 48 小時前全額退款，之後依比例扣除手續費。", {
    outcomes: ["出發 48 小時前取消全額退款", "48 小時內依剩餘時間比例扣手續費"],
    decisions: ["全額退款的期限為出發前 48 小時"],
    next: ["與港務局清艙時程確認是否足夠重新售出座位"],
    files: ["src/refunds/policy.ts"],
  }),
  knowledge("k.refund-48", "s.refund-48", "decision", "退票出發前 48 小時全額退款", "旅客於出發前 48 小時（含）以前取消，全額退款；之後依剩餘時間比例扣除手續費。", {
    tags: ["退票", "退款"],
    appliesTo: ["src/refunds/**"],
  }),
  session("s.manifest-weight", "艙單車輛重量以 10 公斤進位", "港務局要求艙單車輛重量以 10 公斤為單位向上進位。", {
    outcomes: ["艙單車輛重量欄位向上進位到 10 公斤", "加入邊界值測試（1 公斤、10 公斤、11 公斤）"],
    decisions: ["艙單車輛重量以 10 公斤為單位向上進位"],
    next: [],
    files: ["src/manifest/weight.ts"],
  }),
  knowledge("k.manifest-weight", "s.manifest-weight", "pattern", "艙單車輛重量以 10 公斤向上進位", "艙單上的車輛重量以 10 公斤為單位向上進位（1 公斤算 10 公斤、11 公斤算 20 公斤），這是港務局規格。", {
    tags: ["艙單", "重量", "進位"],
    appliesTo: ["src/manifest/weight.ts"],
  }),
  session("s.admin-ui", "管理後台航班清單頁", "營運人員可在管理後台檢視、搜尋與停開航班。", {
    outcomes: ["航班清單支援依日期與航線篩選", "停開航班會同步通知已訂位旅客"],
    decisions: [],
    next: ["批次停開功能待設計"],
    files: ["src/admin/flights-page.ts"],
  }),
  session("s.rate-limit", "API 限流", "公開 API 加上每個 IP 每分鐘 120 次的限流。", {
    outcomes: ["公開 API 每 IP 每分鐘最多 120 次請求", "超過限制回 429 並帶 Retry-After"],
    decisions: ["限流依 IP 計算，已登入旅客不另外放寬"],
    next: ["內部服務呼叫需要白名單"],
    files: ["src/api/rate-limit.ts"],
  }),
  session("s.i18n", "介面多語系（繁中、英文）", "訂位介面支援繁體中文與英文，文案集中管理。", {
    outcomes: ["介面文案集中到 locales 目錄，支援繁中與英文", "日期與金額依語系格式化"],
    decisions: [],
    next: ["日文介面待評估"],
    files: ["src/web/locales/zh-TW.json", "src/web/locales/en.json"],
  }),
  session("s.a11y", "訂位流程無障礙調整", "訂位流程支援鍵盤操作與螢幕閱讀器，選位圖提供文字替代。", {
    outcomes: ["選位流程可完全以鍵盤操作", "座位圖提供文字替代描述"],
    decisions: [],
    next: ["色彩對比度需再檢查"],
    files: ["src/web/seat-map.ts"],
  }),
  session("s.log-format", "結構化日誌格式", "後端日誌改為 JSON 行格式，統一 requestId 欄位。", {
    outcomes: ["日誌輸出為 JSON 行，含 requestId、level、module", "付款與保留流程日誌帶 bookingId"],
    decisions: ["日誌不得記錄旅客證件號碼與卡號"],
    next: [],
    files: ["src/shared/logger.ts"],
  }),
  session("s.hold-lazy", "座位保留改為讀取時判斷過期，移除 sweeper", "競態根源是 sweeper；改為查詢座位可用性時才判斷 expires_at，不再排程清理。", {
    parent: "s.hold-race",
    outcomes: ["座位可用性查詢時判斷 expires_at，過期保留視為不存在（lazy expiry）", "HoldSweeper 與排程已移除，付款競態測試維持通過"],
    decisions: ["保留過期改為讀取時判斷（lazy expiry），不再使用 sweeper 排程"],
    next: ["過期的 holds 列需要每週一次的低頻清除，避免資料表膨脹"],
    files: ["src/holds/availability.ts", "src/holds/sweeper.ts"],
  }),
  knowledge("k.lazy-expiry", "s.hold-lazy", "decision", "座位保留過期改為讀取時判斷（lazy expiry）", "座位保留是否過期在讀取座位可用性時以 expires_at 判斷（lazy expiry），不再使用 sweeper 排程清理。這消除了 sweeper 與付款回呼的競態來源；過期列只做每週一次的低頻清除。", {
    tags: ["holds", "過期", "lazy-expiry"],
    appliesTo: ["src/holds/availability.ts"],
    supersedes: "k.sweeper",
  }),
  session("s.fare-nocache", "取消票價快取", "旺季調價後快取讓舊票價最長殘留 24 小時並引發客訴；移除票價快取。", {
    parent: "s.fare-cache",
    applied: ["k.fare-order"],
    outcomes: ["票價快取已移除，每次查詢直接讀 fare_rules", "為 fare_rules 補上 (route_id, passenger_type) 索引，查詢時間維持在可接受範圍"],
    decisions: ["不快取票價結果：旺季調價必須立即生效，查詢效能改靠索引"],
    next: [],
    files: ["src/fares/cache.ts", "db/migrations/008_fare_index.sql"],
  }),
  knowledge("k.fare-nocache", "s.fare-nocache", "decision", "票價不快取，查詢效能靠索引", "不快取票價計算結果。快取曾讓旺季調價後舊票價最長殘留 24 小時，造成客訴；查詢效能改以 fare_rules 的 (route_id, passenger_type) 索引維持。", {
    tags: ["票價", "快取"],
    appliesTo: ["src/fares/**"],
    supersedes: "k.fare-cache",
  }),
  session("s.pay-poll", "付款狀態輪詢加 webhook 雙軌", "webhook 延遲時伺服端重試會造成多餘的 charge 嘗試；改為輪詢與 webhook 雙軌，取消客戶端重試。", {
    parent: "s.pay-retry",
    contradicted: ["k.pay-retry"],
    outcomes: ["付款確認改為狀態輪詢加 webhook 雙軌，先到者生效", "移除伺服端自動重試 3 次的邏輯"],
    decisions: ["不再由伺服端重試付款；以輪詢加 webhook 確認結果，避免 webhook 延遲時重複嘗試"],
    next: ["輪詢間隔與逾時上限需要調校"],
    files: ["src/payments/poller.ts", "src/payments/retry.ts"],
  }),
  session("s.waitlist-cap", "候補上限每航班 30 人", "每個航班候補名單上限 30 人，額滿後不再接受。", {
    parent: "s.waitlist-fair",
    applied: ["k.waitlist-fifo"],
    outcomes: ["每航班候補上限 30 人，額滿顯示已額滿候補", "已在名單內的旅客順位不受影響"],
    decisions: ["候補上限訂為 30 人，原因是超過 30 人後實際遞補機率低於 2%，且通知成本高"],
    next: [],
    files: ["src/waitlist/limits.ts"],
  }),
  knowledge("k.waitlist-cap", "s.waitlist-cap", "decision", "每航班候補上限 30 人", "每個航班候補名單上限為 30 人。超過 30 人後實際遞補機率低於 2%，且通知成本高，所以額滿後不再接受新的候補。", {
    tags: ["候補", "上限"],
    appliesTo: ["src/waitlist/limits.ts"],
  }),
  session("s.refund-72", "退票全額退款期限改為 72 小時", "港務局清艙時程提前，全額退款期限由 48 小時改為 72 小時。", {
    parent: "s.refund-48",
    outcomes: ["全額退款期限改為出發前 72 小時", "舊訂單依訂位當時規則計算，不追溯"],
    decisions: ["全額退款期限改為 72 小時，因為港務局清艙提前，座位需要時間重新售出"],
    next: [],
    files: ["src/refunds/policy.ts"],
  }),
  knowledge("k.refund-72", "s.refund-72", "decision", "退票出發前 72 小時全額退款", "旅客於出發前 72 小時（含）以前取消，全額退款。由 48 小時改為 72 小時，因為港務局清艙時程提前，座位需要時間重新售出；舊訂單依訂位當時的規則。", {
    tags: ["退票", "退款"],
    appliesTo: ["src/refunds/**"],
    supersedes: "k.refund-48",
  }),
  session("s.fax-retire", "停用傳真流程", "港務局開放入口網站接收乘客名單，停用傳真流程。", {
    outcomes: ["乘客名單改由入口網站 API 上傳，傳真排程已停用", "移除傳真供應商設定"],
    decisions: ["不再傳真乘客名單給港務局，一律使用入口網站"],
    next: [],
    files: ["src/manifest/fax.ts", "src/manifest/portal.ts"],
  }),
  { op: "archive", key: "k.legacy-fax" },
  session("s.csv-retire", "移除艙單 CSV 匯出，改上傳入口網站", "艙單改以入口網站 JSON API 上傳，CSV 匯出功能移除。", {
    parent: "s.manifest-csv",
    related: ["s.fax-retire"],
    outcomes: ["艙單改以入口網站 JSON API 上傳", "CSV 匯出程式與欄位順序規格文件已移除"],
    decisions: ["艙單不再匯出 CSV，一律上傳入口網站"],
    next: [],
    files: ["src/manifest/export-csv.ts", "src/manifest/portal.ts"],
  }),
  { op: "archive", key: "k.csv-manifest" },
  session("s.wrong-fare", "旺季加成改為 40%（誤記）", "把測試資料當成正式調整，記錄旺季加成改為 40%。", {
    outcomes: ["記錄旺季加成改為 40%"],
    decisions: ["旺季加成調整為 40%"],
    next: [],
    files: ["src/fares/surcharge.ts"],
  }),
  { op: "void", key: "s.wrong-fare", reason: "誤記：該調整只是測試資料，並未上線" },
  session("s.db-migrate", "資料庫遷移腳本規範", "遷移腳本需可重複執行且附回滾說明。", {
    outcomes: ["遷移腳本一律以序號命名並可重複執行", "每個遷移附回滾說明"],
    decisions: ["遷移腳本不得包含資料修正以外的商業邏輯"],
    next: [],
    files: ["db/README.md"],
  }),
  session("s.perf-search", "航班搜尋效能調校", "航班搜尋加上複合索引，P95 由 900 ms 降到 120 ms。", {
    outcomes: ["航班搜尋加上 (route_id, departure_date) 複合索引", "P95 由 900 ms 降到 120 ms"],
    decisions: [],
    next: ["搜尋結果分頁待實作"],
    files: ["db/migrations/009_flight_search_index.sql"],
  }),
  session("s.seat-map", "座位圖元件", "新增互動式座位圖，顯示可選、保留中、已售出狀態。", {
    outcomes: ["座位圖以三種顏色顯示可選、保留中、已售出", "保留中的座位顯示他人保留的倒數"],
    decisions: [],
    next: ["行動裝置縮放行為待調整"],
    files: ["src/web/seat-map.ts"],
  }),
  session("s.coupon", "優惠券折抵", "支援固定金額與百分比優惠券，屬於折扣階段。", {
    outcomes: ["優惠券可為固定金額或百分比", "每張訂單最多使用一張優惠券"],
    decisions: ["優惠券屬於折扣階段，依票價計算順序先於旺季加成"],
    next: [],
    files: ["src/fares/coupon.ts"],
  }),
  session("s.group-booking", "團體訂位", "10 人以上的團體訂位走人工審核流程，單次最多 40 人。", {
    outcomes: ["10 人以上的訂位進入人工審核，通過後才扣款", "單次團體訂位上限 40 人"],
    decisions: ["團體訂位門檻為 10 人，一次最多 40 人，超過需分次訂位"],
    next: ["團體折扣規則待業務確認"],
    files: ["src/bookings/group.ts"],
  }),
  session("s.email-tpl", "電子郵件範本", "訂位確認與取消信件改用範本引擎。", {
    outcomes: ["訂位確認與取消信件使用範本，支援繁中與英文", "範本變數有型別檢查"],
    decisions: [],
    next: [],
    files: ["src/notify/templates/booking-confirmed.html"],
  }),
  session("s.backup", "備份與還原演練", "資料庫每日備份並完成一次還原演練。", {
    outcomes: ["資料庫每日 03:00 備份並保留 14 份", "完成一次還原演練，耗時 11 分鐘"],
    decisions: ["備份檔加密存放，金鑰與備份分開保管"],
    next: ["還原演練改為每季一次"],
    files: ["ops/backup.sh"],
  }),
  session("s.holiday-calendar", "假日曆整合", "peak_calendar 改由年度假日曆匯入，減少人工維護。", {
    outcomes: ["peak_calendar 可由年度假日曆檔匯入", "匯入前顯示差異預覽"],
    decisions: [],
    next: [],
    files: ["src/fares/peak-calendar-import.ts"],
  }),
  session("s.e2e-tests", "端對端測試", "加入訂位、付款、退票的端對端測試。", {
    outcomes: ["訂位到付款的端對端測試通過", "退票流程端對端測試涵蓋 72 小時邊界"],
    decisions: [],
    next: ["候補流程尚未納入"],
    files: ["tests/e2e/booking.spec.ts"],
  }),
  session("s.error-codes", "錯誤碼整理", "API 錯誤碼整理為固定清單並附說明文件。", {
    outcomes: ["API 錯誤碼整理為固定清單", "每個錯誤碼附中文說明與處理建議"],
    decisions: [],
    next: [],
    files: ["docs/error-codes.md"],
  }),
  session("s.vessel-capacity", "船艙容量設定", "每艘船的客艙與車輛甲板容量可在後台設定。", {
    outcomes: ["海燕號與白鷺號的客艙、車輛甲板容量可由後台設定", "容量變更不影響既有訂位"],
    decisions: [],
    next: [],
    files: ["src/vessels/capacity.ts"],
  }),
  session("s.checkin-qr", "QR 報到", "每張船票產生一次性 QR token，掃碼報到後立即失效。", {
    outcomes: ["每張船票產生一次性 QR token，掃碼後立即失效", "掃碼端離線時使用當日航班白名單快取"],
    decisions: ["報到 token 一次性使用，離線時以白名單快取驗證"],
    next: ["離線報到資料回傳後的對帳"],
    files: ["src/checkin/qr.ts"],
  }),
  session("s.docs-update", "文件更新", "更新開發環境與部署文件。", {
    outcomes: ["更新開發環境安裝與部署文件", "補上常見錯誤排除章節"],
    decisions: [],
    next: [],
    files: ["docs/setup.md"],
  }),
  session("s.cancel-flow", "取消訂位流程重構", "取消流程拆成試算、確認、退款三步，避免退款失敗時訂位已被取消。", {
    outcomes: ["取消流程拆為試算、確認、退款三步，每步可重入", "退款失敗時訂位維持原狀並寄信通知客服"],
    decisions: ["取消訂位與退款必須在同一個交易邊界內完成狀態轉換，外部退款呼叫在交易之後"],
    next: ["部分退款（單張票）流程待設計"],
    files: ["src/bookings/cancel.ts", "src/refunds/refund-service.ts"],
  }),
  session("s.seat-reassign", "旅客改位功能", "已付款旅客可在出發 24 小時前改選同艙等的其他座位。", {
    outcomes: ["已付款旅客可改選同艙等座位，舊座位立即釋出", "改位次數上限為 2 次，超過需聯絡客服"],
    decisions: ["改位只限同艙等，跨艙等視為退票重訂"],
    next: ["改位與候補遞補同時發生時的順序需要確認"],
    files: ["src/bookings/reassign.ts"],
  }),
  session("s.timeouts", "外部呼叫逾時設定", "統一 HTTP 外部呼叫的連線與讀取逾時。", {
    outcomes: ["所有外部 HTTP 呼叫預設連線逾時 3 秒、讀取逾時 10 秒", "PayStub 呼叫的讀取逾時放寬為 20 秒"],
    decisions: ["逾時設定集中在 http-client，不允許各模組自行設定"],
    next: ["逾時後的告警門檻待訂"],
    files: ["src/shared/http-client.ts"],
  }),
  session("s.audit-log", "稽核日誌", "後台的票價、容量與停開操作寫入稽核日誌。", {
    outcomes: ["後台變更票價、容量與停開操作皆寫入 audit_log", "稽核日誌記錄操作者、前後值與時間"],
    decisions: ["稽核日誌只增不改，保留 2 年"],
    next: ["查詢介面待實作"],
    files: ["src/admin/audit-log.ts", "db/migrations/010_audit_log.sql"],
  }),
  session("s.healthcheck", "健康檢查端點", "新增 /healthz 與 /readyz 供部署平台使用。", {
    outcomes: ["/healthz 只檢查程序存活，/readyz 檢查資料庫連線", "部署平台以 /readyz 決定是否導流"],
    decisions: ["健康檢查不呼叫 PayStub，避免外部故障造成實例被重啟"],
    next: [],
    files: ["src/api/health.ts"],
  }),
  session("s.load-test", "訂位流程壓力測試", "以 300 併發模擬開賣瞬間的選位與付款。", {
    outcomes: ["300 併發選位的錯誤率低於 0.5%", "發現資料庫連線池上限過低，由 10 調整為 30"],
    decisions: ["開賣前一律先跑壓力測試，結果存入 ops 目錄"],
    next: ["付款回呼量大時的佇列行為待測"],
    files: ["ops/load-test/booking.js", "src/shared/db-pool.ts"],
  }),
  session("s.search-pagination", "航班搜尋分頁", "航班搜尋結果加上游標式分頁。", {
    outcomes: ["航班搜尋支援游標式分頁，每頁 20 筆", "前端無限捲動沿用同一 API"],
    decisions: ["分頁游標以 (departure_time, flight_id) 組成，避免 offset 在資料變動時重複"],
    next: [],
    files: ["src/flights/search.ts"],
  }),
  session("s.pets-cabin", "寵物同行艙位", "新增寵物艙位類型，每航班限量 6 隻。", {
    outcomes: ["新增寵物艙位類型，每航班限量 6 隻", "訂位時需勾選寵物體重區間"],
    decisions: ["寵物艙位獨立計量，不佔用客艙座位數"],
    next: ["大型犬規則待營運確認"],
    files: ["src/bookings/pets.ts"],
  }),
  session("s.feature-flags", "功能旗標", "以設定檔控制新功能的灰度開放。", {
    outcomes: ["新增 feature flag 讀取與預設值機制", "團體訂位與寵物艙位改由旗標控制開放"],
    decisions: ["旗標只存在於設定檔，不放資料庫，改動需要重新部署"],
    next: ["清理已全面開放的旗標"],
    files: ["src/shared/flags.ts", "config/flags.yml"],
  }),
  session("s.dock-schedule", "港口靠泊時段表", "匯入港口靠泊時段，航班排程避開衝突時段。", {
    outcomes: ["匯入港口靠泊時段表，建立航班時檢查衝突", "衝突時顯示可用的替代時段"],
    decisions: ["靠泊時段以港口時區輸入，儲存時轉為 UTC"],
    next: [],
    files: ["src/flights/dock-schedule.ts"],
  }),
  session("s.receipt-pdf", "電子收據 PDF", "付款完成後產生可下載的電子收據。", {
    outcomes: ["付款完成後產生電子收據 PDF，含稅額明細", "收據編號依年度與流水號產生"],
    decisions: ["收據不含卡號與身分證字號，只顯示付款方式與末四碼"],
    next: [],
    files: ["src/payments/receipt.ts"],
  }),
  session("s.crew-notes", "航班備註與營運交班", "營運人員可為每個航班留下備註，供下一班交接。", {
    outcomes: ["航班可新增備註並標記是否需要交班", "交班清單依港口與日期排序"],
    decisions: [],
    next: ["備註的權限分級待討論"],
    files: ["src/admin/flight-notes.ts"],
  }),
  session("s.ticket-transfer", "船票轉讓", "旅客可將未使用船票轉讓給同行者，轉讓一次為限。", {
    outcomes: ["船票可轉讓給同行者，轉讓後原 QR token 立即失效", "每張船票只能轉讓一次，轉讓紀錄寫入稽核日誌"],
    decisions: ["轉讓需在出發 6 小時前完成，且新旅客資料需通過同樣的驗證"],
    next: ["轉讓手續費是否收取待業務決定"],
    files: ["src/bookings/transfer.ts"],
  }),
  session("s.weather-delay", "天候延誤通知", "航班因天候延誤或取消時，批次通知已訂位旅客。", {
    outcomes: ["延誤超過 30 分鐘時批次通知已訂位旅客", "取消航班時一併提供改期與退款連結"],
    decisions: ["天候取消屬於不可抗力，一律全額退款，不受退票期限限制"],
    next: ["通知內容需再審視靜音時段的例外"],
    files: ["src/notify/delay.ts"],
  }),
  session("s.vehicle-types", "車輛類型與計價", "車輛依長度與高度分為四個級距計價。", {
    outcomes: ["車輛依長度與高度分為四個計價級距", "超高車輛需於訂位時填寫實際高度"],
    decisions: ["車輛級距以訂位時填寫的尺寸為準，登船時若不符須補差額"],
    next: ["登船端的量測流程待確認"],
    files: ["src/fares/vehicle.ts"],
  }),
  session("s.sms-provider", "簡訊供應商抽象化", "簡訊發送包成 SmsProvider 介面，方便替換供應商。", {
    outcomes: ["新增 SmsProvider 介面與一個沙盒實作", "發送失敗會記錄供應商回傳碼"],
    decisions: ["簡訊重送最多 2 次，仍失敗改寄電子郵件"],
    next: [],
    files: ["src/notify/sms-provider.ts"],
  }),
  session("s.report-daily", "每日營運報表", "每日 06:30 寄出前一日的載客與營收報表。", {
    outcomes: ["每日 06:30 寄出前一日載客率與營收彙總", "報表以港口時區切日"],
    decisions: ["報表一律以港口時區切日，不使用 UTC 日界線"],
    next: ["加入退票率"],
    files: ["src/reports/daily.ts"],
  }),
  session("s.seat-lock-ui", "選位畫面保留倒數提示", "選位畫面在保留剩 2 分鐘時提示旅客盡快付款。", {
    outcomes: ["保留剩 2 分鐘時顯示提示與延長按鈕", "延長保留一次最多 5 分鐘"],
    decisions: ["旅客延長保留只允許一次，避免長時間佔位"],
    next: [],
    files: ["src/web/hold-countdown.ts"],
  }),
  {
    op: "page",
    slug: "in-progress",
    sections: [
      { heading: "近期進行中", content: "QR 報到已完成，離線報到資料回傳後的對帳待處理；船艙容量可由後台設定。", sources: ["s.checkin-qr", "s.vessel-capacity"] },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Seeder
// ---------------------------------------------------------------------------------------------------------------
const GAP_HOURS = 26;
export const PROJECT_NAME = "Tidewater";

/** Fake time used for every read after seeding (one day after the last write). */
export function readTime(seedEndIso) {
  return new Date(Date.parse(seedEndIso) + 24 * 3600_000).toISOString();
}

export function seedFixture(store, root) {
  clock.install();
  clock.set(FIXTURE_START);
  const project = store.addProject(PROJECT_NAME, root);
  store.updateProject(project.id, { status: "tracked" });

  const ids = {};
  const order = [];
  const stats = {
    sessions: 0,
    voidedSessions: 0,
    knowledge: 0,
    knowledgeActive: 0,
    knowledgeSuperseded: 0,
    knowledgeArchived: 0,
    knowledgeNeedsReview: 0,
    continuesLinks: 0,
    relatedLinks: 0,
    pages: 0,
  };
  const resolve = (key) => {
    if (!ids[key]) throw new Error(`fixture key ${key} is not seeded yet`);
    return ids[key];
  };
  const ensure = (result, outcome, what) => {
    if (result.outcome !== outcome) throw new Error(`seed ${what}: ${result.outcome} ${JSON.stringify(result).slice(0, 200)}`);
    return result;
  };

  for (const step of STEPS) {
    if (step.op === "session") {
      clock.advance(GAP_HOURS * 60);
      const result = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: step.key,
        title: step.title,
        summary: step.summary,
        workSummary: {
          outcomes: step.outcomes ?? [],
          scope: [],
          decisions: step.decisions ?? [],
          verification: [],
          nextSteps: step.next ?? [],
        },
        changedFiles: step.files ?? [],
        verification: { status: "passed" },
        ...(step.parent ? { parentSessionId: resolve(step.parent) } : {}),
        ...(step.related ? { relatedSessionIds: step.related.map(resolve) } : {}),
        ...(step.applied ? { appliedKnowledgeIds: step.applied.map(resolve) } : {}),
        ...(step.contradicted ? { contradictedKnowledgeIds: step.contradicted.map(resolve) } : {}),
      });
      ensure(result, "finalized", step.key);
      ids[step.key] = result.session.id;
      stats.sessions += 1;
      if (step.parent) stats.continuesLinks += 1;
      stats.relatedLinks += step.related?.length ?? 0;
      if (step.contradicted) stats.knowledgeNeedsReview += step.contradicted.length;
      order.push(step.key);
    } else if (step.op === "knowledge") {
      clock.advance(2);
      const result = store.recordKnowledge({
        projectRoot: root,
        idempotencyKey: step.key,
        kind: step.kind,
        title: step.title,
        body: step.body,
        sessionId: resolve(step.session),
        tags: step.tags ?? [],
        ...(step.appliesTo ? { appliesTo: step.appliesTo } : {}),
        ...(step.supersedes ? { supersedesId: resolve(step.supersedes) } : {}),
      });
      ensure(result, "knowledge_recorded", step.key);
      ids[step.key] = result.knowledge.id;
      stats.knowledge += 1;
      if (step.supersedes) stats.knowledgeSuperseded += 1;
    } else if (step.op === "archive") {
      clock.advance(3);
      ensure(
        store.updateKnowledge({ projectRoot: root, knowledgeId: resolve(step.key), status: "archived" }),
        "knowledge_updated",
        `archive ${step.key}`,
      );
      stats.knowledgeArchived += 1;
    } else if (step.op === "void") {
      clock.advance(3);
      const result = store.setSessionVoid({ sessionId: resolve(step.key), voided: true, reason: step.reason });
      if (result.outcome === "not_found" || result.outcome === "skipped") throw new Error(`void ${step.key}: ${result.outcome}`);
      stats.voidedSessions += 1;
      order.splice(order.indexOf(step.key), 1);
    } else if (step.op === "page") {
      clock.advance(3);
      writePage(store, root, step, resolve, ids);
      stats.pages += 1;
    }
  }
  stats.knowledgeActive = stats.knowledge - stats.knowledgeSuperseded - stats.knowledgeArchived;
  const seedEnd = clock.iso;
  clock.set(readTime(seedEnd));
  return { project, projectRoot: root, ids, order, stats, seedEnd, readAt: clock.iso };
}

function writePage(store, root, step, resolve, ids) {
  const custom = step.title ? { title: step.title, question: step.question } : {};
  ensureOutcome(store.requestKnowledgePageUpdate({ projectRoot: root, slug: step.slug, ...custom }), "knowledge_page_update_requested", step.slug);
  const context = store.getKnowledgePageContext({ projectRoot: root, slug: step.slug });
  ensureOutcome(context, "knowledge_page_context", `${step.slug} context`);
  const saved = store.saveKnowledgePage({
    projectRoot: root,
    slug: step.slug,
    idempotencyKey: `page.${step.slug}.v1`,
    reviewToken: context.reviewToken,
    sections: step.sections.map((section) => ({
      heading: section.heading,
      content: section.content,
      sourceSessionIds: section.sources.map(resolve),
    })),
  });
  ensureOutcome(saved, "knowledge_page_saved", `${step.slug} save`);
  ids[`page.${step.slug}`] = saved.page.id;
}

function ensureOutcome(result, outcome, what) {
  if (result.outcome !== outcome) throw new Error(`seed ${what}: ${result.outcome} ${JSON.stringify(result).slice(0, 200)}`);
}

export const PAGE_SLUGS = ["architecture", "pitfalls", "in-progress"];
