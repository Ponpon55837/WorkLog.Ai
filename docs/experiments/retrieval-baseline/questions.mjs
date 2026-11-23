// Hard-coded retrieval questions and policy cases for the retrieval baseline.
//
// The gold below was written by hand from the fixture design in fixture.mjs, before any retrieval was run. It is
// never derived from retrieval output. `query` is the "baseline method": the plain, single call an Agent would send
// today. The runner adds `projectRoot` to every call.
//
// Gold fields:
//   mustCite    fixture keys that a good answer must be able to cite (a tool that returns only Sessions or only
//               Knowledge is only asked about keys of that type; see KEY_KIND below).
//   mustNotCite fixture keys that must not be presented as current (superseded, archived, voided, or look-alikes).
//   mustFlag    optional { key: "needsReview" }: the returned record must carry that trust flag.
//   points      the answer points a correct answer contains (zh-TW).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CATEGORIES = {
  A: "直接搜尋",
  B: "決策原因",
  C: "歷史演進",
  D: "衝突過時",
  E: "負例",
};

/** Which kind of record a tool can return, so gold keys are checked against what the tool can answer. */
export const TOOL_RETURNS = {
  recall: ["session", "knowledge"],
  context: ["session", "knowledge"],
  search: ["session"],
  searchKnowledge: ["knowledge"],
};
export const KEY_KIND = (key) => (key.startsWith("k.") ? "knowledge" : "session");

const q = (id, category, question, query, gold) => ({
  id,
  category,
  question,
  query,
  gold: { mustCite: [], mustNotCite: [], points: [], ...gold },
});

export const QUESTIONS = [
  // ---- A 直接搜尋 ----
  q("A1", "A", "PayStub 的回呼簽章要怎麼驗證？", { tool: "recall", args: { q: "PayStub 回呼簽章驗證" } }, {
    mustCite: ["k.webhook-sig", "s.pay-sig"],
    points: ["使用 HMAC-SHA256 驗證 X-PayStub-Signature", "必須以原始 request body 計算簽章", "不可先解析成 JSON 再重新序列化，否則簽章會偶發失敗"],
  }),
  q("A2", "A", "航班時間顯示晚了 8 小時，當時是怎麼修的？", { tool: "recall", args: { q: "航班時間 時區 顯示錯誤" } }, {
    mustCite: ["s.tz-bug", "k.tz-utc"],
    points: ["根因是以本地時間存入資料庫", "改為一律以 UTC 儲存", "顯示層才依港口時區轉換"],
  }),
  q("A3", "A", "艙單上的車輛重量要怎麼進位？", { tool: "searchKnowledge", args: { q: "艙單 重量 進位" } }, {
    mustCite: ["k.manifest-weight"],
    points: ["以 10 公斤為單位向上進位", "1 公斤算 10 公斤、11 公斤算 20 公斤", "這是港務局規格"],
  }),
  q("A4", "A", "簡訊的夜間靜音時段是幾點到幾點？", { tool: "recall", args: { q: "簡訊 夜間 靜音 時段" } }, {
    mustCite: ["k.notify-quiet", "s.notify-quiet"],
    points: ["港口時區 22:00 至 06:00 不發送簡訊", "延後到 06:00 之後發送", "出發前 2 小時的提醒不受靜音限制"],
  }),
  q("A5", "A", "團體訂位的人數門檻是多少？", { tool: "search", args: { q: "團體訂位 人數" } }, {
    mustCite: ["s.group-booking"],
    points: ["10 人以上走人工審核，通過後才扣款", "單次團體訂位最多 40 人"],
  }),
  q("A6", "A", "QR 報到是怎麼做的？", { tool: "context", args: { task: "QR 報到 怎麼實作" } }, {
    mustCite: ["s.checkin-qr"],
    points: ["每張船票產生一次性 QR token，掃碼後立即失效", "掃碼端離線時使用當日航班白名單快取"],
  }),

  // ---- B 決策原因 ----
  q("B1", "B", "為什麼座位保留要存資料庫，不能放在記憶體？", { tool: "recall", args: { q: "座位保留 為什麼 存資料庫 不放記憶體" } }, {
    mustCite: ["k.hold-db", "s.hold-db"],
    points: ["服務重啟後記憶體中的保留會全部消失", "多個 API 實例之間不共享", "曾發生旅客付款時座位已被他人買走"],
  }),
  q("B2", "B", "為什麼票價要先折扣、再算旺季加成？", { tool: "recall", args: { q: "票價 為什麼 先折扣 再旺季加成" } }, {
    mustCite: ["k.fare-order", "s.fare-order"],
    points: ["旺季加成以折扣後價格計算才符合對外公告的票價", "順序為基本價、折扣、旺季加成、稅", "旺季使用優惠券時曾因順序錯誤多收金額"],
  }),
  q("B3", "B", "付款請求為什麼一律要帶冪等 key？", { tool: "recall", args: { q: "付款 冪等 key 原因" } }, {
    mustCite: ["k.pay-idem", "s.pay-idem"],
    points: ["網路逾時重送曾造成重複扣款", "冪等 key 格式為 bookingId 加 attempt 序號", "重送同一請求閘道只會扣款一次"],
  }),
  q("B4", "B", "為什麼後來取消了票價快取？", { tool: "recall", args: { q: "為什麼取消票價快取" } }, {
    mustCite: ["k.fare-nocache", "s.fare-nocache"],
    mustNotCite: ["k.fare-cache"],
    points: ["快取讓旺季調價後舊票價最長殘留 24 小時並引發客訴", "旺季調價必須立即生效", "查詢效能改靠 fare_rules 的索引"],
  }),
  q("B5", "B", "候補為什麼依申請時間排序，而不是看艙等或會員等級？", { tool: "context", args: { task: "候補 為什麼依申請時間排序 不看艙等" } }, {
    mustCite: ["k.waitlist-fifo", "s.waitlist-fair"],
    points: ["只依申請時間先後（FIFO）", "加權後客服無法向旅客解釋為何排在後面，曾引發客訴"],
  }),
  q("B6", "B", "候補名單上限為什麼是 30 人？", { tool: "searchKnowledge", args: { q: "候補 上限 30" } }, {
    mustCite: ["k.waitlist-cap"],
    points: ["超過 30 人後實際遞補機率低於 2%", "通知成本高，所以額滿後不再接受新的候補"],
  }),
  q("B7", "B", "全額退款期限為什麼改成 72 小時？", { tool: "searchKnowledge", args: { q: "退票 72 小時 原因" } }, {
    mustCite: ["k.refund-72"],
    mustNotCite: ["k.refund-48"],
    points: ["港務局清艙時程提前", "座位需要時間重新售出", "舊訂單依訂位當時的規則，不追溯"],
  }),
  q("B8", "B", "付款確認為什麼改成輪詢加 webhook 雙軌？", { tool: "recall", args: { q: "付款狀態 輪詢 webhook 雙軌 原因" } }, {
    mustCite: ["s.pay-poll"],
    points: ["webhook 延遲時伺服端重試會造成多餘的 charge 嘗試", "改為輪詢與 webhook 先到者生效", "移除伺服端自動重試"],
  }),

  // ---- C 歷史演進（鏈上的 Session 都要找得到；pass 門檻見 runner） ----
  q("C1", "C", "座位保留的設計是怎麼一步步演進的？", { tool: "recall", args: { q: "座位保留 設計 演進" } }, {
    mustCite: ["s.hold-mem", "s.hold-db", "s.hold-sweeper", "s.hold-race", "s.hold-lazy"],
    points: ["先用記憶體 Map，重啟會遺失", "改存 holds 資料表", "加入 60 秒 sweeper 清理過期", "付款回呼與 sweeper 競態，加 hold version", "最後改為讀取時判斷過期（lazy expiry），移除 sweeper"],
  }),
  q("C2", "C", "票價引擎從一開始到現在經過哪些變化？", { tool: "recall", args: { q: "票價 規則 演進" } }, {
    mustCite: ["s.fare-hardcode", "s.fare-table", "s.peak", "s.fare-order", "s.fare-cache", "s.fare-nocache"],
    points: ["先以常數表寫死票價", "改為 fare_rules 資料表", "加入 15% 旺季加成", "修正折扣與加成的疊加順序", "曾加入票價快取，後來因旺季調價延遲而移除"],
  }),
  q("C3", "C", "付款整合是怎麼演進的？", { tool: "context", args: { task: "付款整合 演進 歷程" } }, {
    mustCite: ["s.pay-sandbox", "s.pay-sig", "s.pay-idem", "s.pay-retry", "s.pay-poll"],
    points: ["先接 PayStub 沙盒", "加入 webhook 簽章驗證", "加入冪等 key", "加入 3 次指數退避重試", "最後改為輪詢加 webhook 雙軌並取消重試"],
  }),
  q("C4", "C", "候補名單的規則是怎麼形成的？", { tool: "recall", args: { q: "候補名單 設計 歷史" } }, {
    mustCite: ["s.waitlist-basic", "s.waitlist-notify", "s.waitlist-fair", "s.waitlist-cap"],
    points: ["先有候補基本功能", "加入遞補通知與 15 分鐘確認期限", "決定依申請時間 FIFO 排序", "最後訂出每航班 30 人上限"],
  }),
  q("C5", "C", "退票規則曾經怎麼改過？", { tool: "search", args: { q: "退票 規則 變更" } }, {
    mustCite: ["s.refund-48", "s.refund-72"],
    points: ["原本出發前 48 小時全額退款", "後來因港務局清艙提前改為 72 小時"],
  }),
  q("C6", "C", "艙單匯出方式有什麼變遷？", { tool: "recall", args: { q: "艙單 匯出 變遷" } }, {
    mustCite: ["s.manifest-csv", "s.csv-retire"],
    mustNotCite: ["k.csv-manifest"],
    points: ["最初匯出 CSV 給港務局，欄位順序固定", "後來移除 CSV，改上傳入口網站 JSON API", "CSV 格式的 Knowledge 已作廢，不可當作現行做法"],
  }),

  // ---- D 衝突過時 ----
  q("D1", "D", "座位保留的過期現在是怎麼清理的？", { tool: "searchKnowledge", args: { q: "座位保留 過期 清理" } }, {
    mustCite: ["k.lazy-expiry"],
    mustNotCite: ["k.sweeper"],
    points: ["現行做法是讀取座位可用性時以 expires_at 判斷（lazy expiry）", "sweeper 排程已被取代，不可當作現行做法"],
  }),
  q("D2", "D", "票價現在要不要快取？", { tool: "recall", args: { q: "票價 要不要 快取" } }, {
    mustCite: ["k.fare-nocache", "s.fare-nocache"],
    mustNotCite: ["k.fare-cache"],
    points: ["現行決策是不快取", "舊的「快取至每日 04:00」決策已被取代"],
  }),
  q("D3", "D", "全額退款的期限是出發前多久？", { tool: "searchKnowledge", args: { q: "全額退款 期限" } }, {
    mustCite: ["k.refund-72"],
    mustNotCite: ["k.refund-48"],
    points: ["現行為出發前 72 小時", "48 小時是舊規則，已被取代"],
  }),
  q("D4", "D", "付款失敗要重試幾次？", { tool: "recall", args: { q: "付款失敗 重試 幾次" } }, {
    mustCite: ["k.pay-retry", "s.pay-poll"],
    mustFlag: { "k.pay-retry": "needsReview" },
    points: ["舊決策是伺服端重試 3 次指數退避，但已被後來的 Session 否定、標記為需複核", "現行做法是不重試，改用輪詢加 webhook"],
  }),
  q("D5", "D", "乘客名單還需要傳真給港務局嗎？", { tool: "recall", args: { q: "乘客名單 傳真 港務局" } }, {
    mustCite: ["s.fax-retire"],
    mustNotCite: ["k.legacy-fax"],
    points: ["不需要，傳真流程已停用", "一律改用港務局入口網站上傳", "「出發前 2 小時傳真」的 Knowledge 已作廢"],
  }),
  q("D6", "D", "旺季加成的比例是多少？有沒有改成 40%？", { tool: "search", args: { q: "旺季加成 比例" } }, {
    mustCite: ["s.peak"],
    mustNotCite: ["s.wrong-fare"],
    points: ["旺季加成為 15%（7 至 8 月與春節）", "「改成 40%」是已作廢的誤記 Session，不可採信"],
  }),

  // ---- E 負例：專案中沒有答案，正確行為是回報查無 ----
  q("E1", "E", "停車場預約的車位是怎麼分配的？", { tool: "recall", args: { q: "停車場 預約 車位 分配" } }, {
    mustNotCite: ["s.hold-db", "k.hold-db", "s.seat-map"],
    points: ["專案沒有停車場預約功能，應回答查無相關資料；座位保留是船艙座位，不是停車位"],
  }),
  q("E2", "E", "多幣別匯率轉換規則是什麼？", { tool: "context", args: { task: "多幣別 匯率 轉換 規則" } }, {
    mustNotCite: ["k.fare-order", "s.fare-order"],
    points: ["專案沒有多幣別或匯率功能，應回答查無相關資料；票價計算順序與幣別無關"],
  }),
  q("E3", "E", "Apple Pay 付款整合的結論是什麼？", { tool: "searchKnowledge", args: { q: "Apple Pay 付款 整合" } }, {
    mustNotCite: ["k.pay-idem", "k.webhook-sig"],
    points: ["沒有 Apple Pay 整合記錄，應回答查無相關資料；PayStub 的記錄不是 Apple Pay"],
  }),
  q("E4", "E", "會員點數兌換規則是什麼？", { tool: "recall", args: { q: "會員 點數 兌換 規則" } }, {
    mustNotCite: ["k.fare-order", "s.coupon", "k.waitlist-fifo"],
    points: ["專案沒有會員點數功能，應回答查無相關資料；優惠券與候補排序都不是點數兌換"],
  }),
];

// ---------------------------------------------------------------------------------------------------------------
// Policy cases: product guarantees that must hold 100% of the time. They are separate from the retrieval stats.
// Each `run(ctx)` gets a freshly seeded project: { store, root, ids, order, clock } and throws on failure.
// ---------------------------------------------------------------------------------------------------------------
const fakeId = "00000000-0000-4000-8000-000000000001";

function seedOtherProject(ctx, name) {
  const root = mkdtempSync(join(tmpdir(), "rb-other-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const project = ctx.store.addProject(name, root);
  ctx.store.updateProject(project.id, { status: "tracked" });
  const result = ctx.store.finalizeSession({
    projectRoot: root,
    idempotencyKey: `other.${name}`,
    title: "其他專案的 Session",
    summary: "與 Tidewater 無關的虛構專案。",
    changedFiles: [],
    verification: { status: "passed" },
  });
  assert.equal(result.outcome, "finalized");
  return { root, sessionId: result.session.id };
}

function knowledgeRecord(ctx, key, q) {
  const result = ctx.store.searchKnowledgeForAgent({ projectRoot: ctx.root, q });
  assert.equal(result.outcome, "knowledge");
  return result.items.find((item) => item.id === ctx.ids[key]);
}

export const policyCases = [
  {
    id: "P1",
    title: "不得捏造來源：不存在、已作廢或他專案的 sourceSessionId 一律以 invalid_sources 拒絕，頁面不變",
    run(ctx) {
      const { store, root, ids } = ctx;
      store.requestKnowledgePageUpdate({ projectRoot: root, slug: "release-notes", title: "發行紀錄", question: "近期發行包含哪些變更？" });
      const other = seedOtherProject(ctx, "Elsewhere");
      const attempt = (suffix, sessionId) =>
        store.saveKnowledgePage({
          projectRoot: root,
          slug: "release-notes",
          idempotencyKey: `p1.${suffix}`,
          sections: [{ heading: "變更", content: "示意內容", sourceSessionIds: [sessionId] }],
        });
      for (const [suffix, sessionId] of [
        ["missing", fakeId],
        ["voided", ids["s.wrong-fare"]],
        ["foreign", other.sessionId],
      ]) {
        const result = attempt(suffix, sessionId);
        assert.equal(result.outcome, "invalid_sources", `${suffix} source must be rejected`);
        assert.deepEqual(result.sessionIds, [sessionId]);
      }
      const page = store.listKnowledgePages({ projectRoot: root }).items.find((item) => item.slug === "release-notes");
      assert.equal(page.version, 0, "a rejected save must not create a version");
      // Control: a real, non-voided Session of this project is accepted.
      assert.equal(attempt("valid", ids["s.docs-update"]).outcome, "knowledge_page_saved");
    },
  },
  {
    id: "P2",
    title: "未讀過的 Session 不得被標為已涵蓋：截斷的 reviewToken 存檔後，被截掉的 Session 仍是新資料",
    run(ctx) {
      const { store, root, ids, order } = ctx;
      const context = store.getKnowledgePageContext({ projectRoot: root, slug: "architecture" });
      assert.equal(context.outcome, "knowledge_page_context");
      assert.equal(context.mode, "review");
      assert.equal(context.truncated, true, "the fixture page must be truncated for this case");
      const pending = order.slice(order.indexOf("s.waitlist-notify") + 1).map((key) => ids[key]);
      const shown = context.sessions.filter((session) => session.reason === "new").map((session) => session.id);
      const omitted = pending.filter((id) => !shown.includes(id));
      assert(shown.length > 0 && omitted.length > 0, "some Sessions must be shown and some omitted");
      const saved = store.saveKnowledgePage({
        projectRoot: root,
        slug: "architecture",
        idempotencyKey: "p2.save",
        reviewToken: context.reviewToken,
        sections: [{ heading: "座位保留", content: "依已讀的 Session 更新。", sourceSessionIds: [shown[0]] }],
      });
      assert.equal(saved.outcome, "knowledge_page_saved");
      assert.equal(saved.warnings, undefined, "a save with reviewToken must not carry the unchecked-coverage warning");
      const next = store.getKnowledgePageContext({ projectRoot: root, slug: "architecture" });
      assert.equal(next.mode, "review");
      const nextIds = next.sessions.filter((session) => session.reason === "new").map((session) => session.id);
      assert.equal(nextIds[0], omitted[0], "the first omitted Session must be the first new one");
      assert(nextIds.every((id) => omitted.includes(id)), "no already-shown Session may come back");
      assert(shown.every((id) => !nextIds.includes(id)));
      assert.equal(next.page.newSessionCount, omitted.length, "every omitted Session must still count as new");
    },
  },
  {
    id: "P3",
    title: "needsReview 不得無故清除：讀取、檢查頁面、無關 finalize、一般編輯都不清除；明確 applied 才清除",
    run(ctx) {
      const { store, root, ids } = ctx;
      const flagged = () => knowledgeRecord(ctx, "k.pay-retry", "付款 重試")?.review?.reason;
      assert.equal(flagged(), "contradicted", "fixture precondition: k.pay-retry is flagged");
      // Plain reads.
      store.recall({ projectRoot: root, q: "付款 重試" });
      store.getContext(root, { task: "付款 重試" });
      store.searchForAgent("付款 重試", root);
      store.getKnowledgePageContext({ projectRoot: root, slug: "architecture" });
      assert.equal(flagged(), "contradicted", "reads must not clear the flag");
      // Page maintenance.
      const checked = store.markKnowledgePageChecked({ projectRoot: root, slug: "architecture", throughSessionId: ids["s.pay-poll"] });
      assert.equal(checked.outcome, "knowledge_page_checked");
      store.requestKnowledgePageUpdate({ projectRoot: root, slug: "pitfalls" });
      assert.equal(flagged(), "contradicted", "page maintenance must not clear the flag");
      // An unrelated finalize that applies other Knowledge.
      const unrelated = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: "p3.unrelated",
        title: "無關的後續工作",
        summary: "只套用另一則 Knowledge。",
        changedFiles: [],
        verification: { status: "passed" },
        appliedKnowledgeIds: [ids["k.hold-db"]],
      });
      assert.equal(unrelated.outcome, "finalized");
      assert.equal(flagged(), "contradicted", "an unrelated finalize must not clear the flag");
      // An ordinary edit without confirm.
      const edited = store.updateKnowledge({ projectRoot: root, knowledgeId: ids["k.pay-retry"], tags: ["付款", "重試", "待複核"] });
      assert.equal(edited.outcome, "knowledge_updated");
      assert.equal(flagged(), "contradicted", "an edit without confirm must not clear the flag");
      // Control: a Session that explicitly applied it (cause) clears the flag.
      const cause = store.finalizeSession({
        projectRoot: root,
        idempotencyKey: "p3.cause",
        title: "確認舊決策仍成立",
        summary: "重新驗證後確認仍成立。",
        changedFiles: [],
        verification: { status: "passed" },
        appliedKnowledgeIds: [ids["k.pay-retry"]],
      });
      assert.equal(cause.outcome, "finalized");
      assert.equal(flagged(), undefined, "an explicit applied confirmation clears the flag");
    },
  },
  {
    id: "P4",
    title: "reviewToken 綁定頁面與版本：別頁的 token 與過期的 token 都不會寫入",
    run(ctx) {
      const { store, root, ids } = ctx;
      const arch = store.getKnowledgePageContext({ projectRoot: root, slug: "architecture" });
      const section = [{ heading: "座位保留", content: "示意", sourceSessionIds: [ids["s.hold-db"]] }];
      const wrongPage = store.saveKnowledgePage({ projectRoot: root, slug: "pitfalls", idempotencyKey: "p4.wrong", reviewToken: arch.reviewToken, sections: section });
      assert.equal(wrongPage.outcome, "invalid_review_token");
      const first = store.saveKnowledgePage({ projectRoot: root, slug: "architecture", idempotencyKey: "p4.first", reviewToken: arch.reviewToken, sections: section });
      assert.equal(first.outcome, "knowledge_page_saved");
      const stale = store.saveKnowledgePage({ projectRoot: root, slug: "architecture", idempotencyKey: "p4.stale", reviewToken: arch.reviewToken, sections: section });
      assert.equal(stale.outcome, "version_conflict");
      const pages = store.listKnowledgePages({ projectRoot: root }).items;
      assert.equal(pages.find((page) => page.slug === "architecture").version, 2);
      assert.equal(pages.find((page) => page.slug === "pitfalls").version, 1);
    },
  },
  {
    id: "P5",
    title: "markKnowledgePageChecked 只接受本專案未作廢的 Session，游標不得倒退，也不得隱藏更晚的 Session",
    run(ctx) {
      const { store, root, ids, clock } = ctx;
      const mark = (sessionId) => store.markKnowledgePageChecked({ projectRoot: root, slug: "in-progress", throughSessionId: sessionId });
      assert.equal(mark(fakeId).outcome, "invalid_cursor");
      assert.equal(mark(ids["s.wrong-fare"]).outcome, "invalid_cursor", "a voided Session is not a valid cursor");
      const other = seedOtherProject(ctx, "Elsewhere");
      assert.equal(mark(other.sessionId).outcome, "invalid_cursor", "another project's Session is not a valid cursor");
      // The page is fresh, so move the cursor between two new Sessions it has never seen: add them first.
      const added = [1, 2, 3].map((n) => {
        clock.advance(60);
        const result = store.finalizeSession({
          projectRoot: root,
          idempotencyKey: `p5.new-${n}`,
          title: `新增工作 ${n}`,
          summary: "頁面建立後的新 Session。",
          changedFiles: [],
          verification: { status: "passed" },
        });
        assert.equal(result.outcome, "finalized");
        return result.session.id;
      });
      assert.equal(mark(added[1]).outcome, "knowledge_page_checked");
      const after = store.listKnowledgePages({ projectRoot: root }).items.find((page) => page.slug === "in-progress");
      assert.equal(after.newSessionCount, 1, "only the Session after the cursor stays new");
      assert.equal(mark(added[0]).outcome, "invalid_cursor", "the cursor cannot move backwards");
    },
  },
];
