# 架構圖資料格式 v1

既有 Mermaid 保留；架構圖使用本專案擁有的 JSON 格式，不接受 Archify HTML、腳本或任意 SVG。Agent 先讀 `work-intelligence://agent/architecture-diagram-v1` 的完整 JSON Schema，再以 `kind: "architecture"`、`formatVersion: 1` 與 JSON 字串 `source` 附加或 finalize。

```json
{
  "version": 1,
  "nodes": [
    { "id": "web", "label": "Web", "groupId": "client", "source": { "path": "apps/web/src/App.vue", "line": 1 } },
    { "id": "api", "label": "REST API", "description": "輸入驗證與專案政策", "position": { "x": 360, "y": 80 } }
  ],
  "groups": [{ "id": "client", "label": "用戶端" }],
  "edges": [{ "id": "request", "from": "web", "to": "api", "label": "送出" }],
  "paths": [{ "id": "save", "label": "儲存流程", "edgeIds": ["request"] }]
}
```

來源最多 100,000 字元、200 節點、500 連線、40 個平面群組、20 條作者路徑。Mermaid 來源仍限制 20,000 字元。標籤最多 200 字元、描述 1,000 字元；位置為 0–10,000 的有限數值。ID 使用 1–32 字元的小寫英文字母開頭，後接小寫字母、數字、底線或連字號，每個集合內不可重複，且不可使用憑證前綴 `sk-`／`xox*-`。`edges`、`groups`、`paths` 省略時為空陣列。

節點的群組、連線兩端與路徑連線都必須存在；路徑須依順序首尾相接，可以描述循環。作者路徑表示文件意圖，沒有宣稱實際執行或追蹤資料。來源 `path` 只能是沒有穿越或 URL 的專案相對路徑，`line` 為正整數；它是中繼資料，不授權讀檔。所有文字以純文字顯示，未知欄位與版本拒絕。

SQLite migration 27 保留舊圖表、同時間排序與作廢狀態，新增 `format_version`（舊圖預設 1）。圖表仍跟隨 SessionDetail、匯出／匯入、作廢／還原與專案／Session 永久刪除。舊 Mermaid 匯出沒有版本欄位仍可匯入；架構 JSON 遮蔽字串值後重新序列化，保持 JSON 語法；遮蔽後的標籤／描述保持欄位長度界限，含敏感值的來源路徑移除。

單張附加的冪等比對包含種類、版本、標題及規範化來源；同鍵不同種類會衝突。Session finalize 既有冪等語意不變：相同 finalize 鍵重送回傳已保存 Session，沒有藉重送更改圖表；新增圖表另用附加操作。

本資料階段對架構圖顯示可展開的來源資料；原生互動閱讀器在下一階段導入。更新主安裝後，schema／Agent 契約變更需要重新連線。
