// Vercel serverless function — đọc Google Sheet qua gviz endpoint (server-side,
// tránh CORS). Query param: ?tab=YYYY-MM-DD
// Không chứa secret/key — Sheet được chia sẻ công khai (Anyone with the link = Viewer).

const SHEETS = {
  ttbd: "19e3KHvRoNpafKkaXyEr4Eh9xRHDIx-jLDbtWXeB2BNc",
  rb: "1cpAZY4-BskFR3i8uWyocKYk-v173Pu3j2RaRlAazufg",
};

/**
 * Bóc wrapper google.visualization.Query.setResponse(...); rồi JSON.parse.
 * @param {string} text - raw text từ gviz endpoint
 * @returns {object} payload gviz
 */
export function parseGvizResponse(text) {
  const m = String(text).match(
    /google\.visualization\.Query\.setResponse\(([\s\S]*)\)\s*;?\s*$/
  );
  if (!m) throw new Error("Phan hoi gviz khong hop le");
  return JSON.parse(m[1]);
}

function cellText(c) {
  if (c == null || c.v == null) return "";
  // Ô kiểu ngày: v = "Date(2026,9,6,...)" -> dùng f (định dạng hiển thị) cho đẹp
  if (typeof c.v === "string" && c.v.startsWith("Date(") && c.f) return c.f;
  return c.v;
}

const toNum = (x) => {
  const n = parseInt(String(x).replace(/[^\d-]/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
};

/**
 * Parse table gviz (headers=0, tức mọi hàng đều là data) theo schema tab ngày:
 * - Hàng chứa "TỔNG VIDEO" -> hàng kế tiếp là 4 con số tóm tắt
 * - Hàng chứa "Mã video" -> header cột, các hàng sau là dữ liệu
 * @param {object} table - payload.table từ gviz
 * @returns {{summary:{total,building,qa,published}, columns:string[], rows:any[][]}}
 */
export function parseSheetTable(table) {
  const rows = (table.rows || []).map((r) => (r.c || []).map(cellText));
  const norm = (s) => String(s).trim().toUpperCase();
  const summary = { total: 0, building: 0, qa: 0, published: 0 };
  let columns = [];
  let dataStart = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.some((c) => norm(c).includes("TỔNG VIDEO"))) {
      const nums = rows[i + 1] || [];
      summary.total = toNum(nums[0]);
      summary.building = toNum(nums[1]);
      summary.qa = toNum(nums[2]);
      summary.published = toNum(nums[3]);
    }
    if (row.some((c) => norm(c) === "MÃ VIDEO")) {
      columns = row.map((c) => String(c).trim());
      dataStart = i + 1;
      break;
    }
  }

  const dataRows = rows
    .slice(dataStart)
    .filter((r) => r.some((c) => String(c).trim() !== ""));

  return { summary, columns, rows: dataRows };
}

/**
 * Parse table gviz (headers=0, tức mọi hàng đều là data) theo kiểu "thô":
 * hàng đầu là header cột, các hàng sau là dữ liệu (bỏ hàng trống).
 * Dùng cho các tab không theo schema tab ngày (VD tab "KPI Kênh").
 * @param {object} table - payload.table từ gviz
 * @returns {{columns:string[], rows:any[][]}}
 */
export function parseRawTable(table) {
  const rows = (table.rows || []).map((r) => (r.c || []).map(cellText));
  if (rows.length === 0) return { columns: [], rows: [] };
  const columns = rows[0].map((c) => String(c).trim());
  const dataRows = rows
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ""));
  return { columns, rows: dataRows };
}

export default async function handler(req, res) {
  const tab = String((req.query && req.query.tab) || "").trim();
  const channel = String((req.query && req.query.channel) || "ttbd").trim();
  const SHEET_ID = SHEETS[channel] || SHEETS.ttbd;
  res.setHeader("Cache-Control", "no-store");

  if (!tab) {
    res.status(400).json({ ok: false, error: "Thieu tham so tab" });
    return;
  }

  try {
    const url =
      "https://docs.google.com/spreadsheets/d/" +
      SHEET_ID +
      "/gviz/tq?tqx=out:json&headers=0&sheet=" +
      encodeURIComponent(tab);
    const r = await fetch(url);
    if (!r.ok) throw new Error("Khong doc duoc Sheet (HTTP " + r.status + ")");
    const payload = parseGvizResponse(await r.text());

    if (payload.status === "error") {
      const msg =
        (payload.errors &&
          payload.errors[0] &&
          payload.errors[0].detailed_message) ||
        "Tab khong ton tai";
      res.status(404).json({ ok: false, tab, error: msg });
      return;
    }

    // Cac tab tra du lieu tho, khong parse kieu day-tab.
    const RAW_TABS = { "KPI Kênh": "kpi", "Tiến độ render": "progress", "Video Pipeline": "rb-pipeline", "KPI": "rb-kpi" };
    if (tab in RAW_TABS) {
      const { columns, rows } = parseRawTable(payload.table || {});
      res.status(200).json({ ok: true, type: RAW_TABS[tab], tab, columns, rows, channel });
      return;
    }

    const { summary, columns, rows } = parseSheetTable(payload.table || {});
    if (columns.length === 0) {
      res
        .status(404)
        .json({ ok: false, tab, error: "Tab khong ton tai hoac khong dung dinh dang" });
      return;
    }
    res.status(200).json({ ok: true, tab, summary, columns, rows });
  } catch (err) {
    res.status(500).json({ ok: false, tab, error: err.message || String(err) });
  }
}
