/* Tin Trên Bản Đồ — Trung tâm điều hành: fetch + render */
"use strict";

const API = "/api/sheet";
const START_DATE = "2026-10-05";
const REFRESH_SEC = 30;
const STALE_MS = 3 * 60 * 1000; // quá 3 phút không refresh thành công -> cảnh báo STALE
const STUCK_HOURS = 6; // ĐANG DỰNG quá X giờ -> cần chú ý
const TARGET_PER_DAY = 20;

const cache = new Map(); // tab -> {summary, columns, rows}
let availableTabs = [];
let currentTab = null;
let attentionItems = [];
let kpiChannelData = null; // {columns, rows} từ tab "KPI Kênh"
let prodData = null; // {columns, rows} từ tab "Tiến độ render"
let rbPipelineData = null; // {columns, rows} từ tab "Video Pipeline" (kênh RB)
let currentChannel = "ttbd";
let currentStage = "producing"; // producing | queue | published
let countdown = REFRESH_SEC;
let fetching = false;
let paused = false;
let lastSuccessAt = 0;

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const str = (v) => String(v == null ? "" : v).trim();
const norm = (s) => str(s).toUpperCase();

function colIndex(columns, name, fallback) {
  const i = columns.findIndex((c) => norm(c) === norm(name));
  return i >= 0 ? i : fallback;
}

/** Map tên cột -> index, chịu được lệch vị trí / thiếu cột. */
function colIdx(columns) {
  return {
    code: colIndex(columns, "Mã video", 0),
    title: colIndex(columns, "Tiêu đề", 1),
    status: colIndex(columns, "Trạng thái", 2),
    updated: colIndex(columns, "Cập nhật", 3),
    keyword: colIndex(columns, "Từ khóa mục tiêu", 4),
    url: colIndex(columns, "File video", 8),
    note: colIndex(columns, "Ghi chú", 9),
  };
}

function parseUpdateTime(s) {
  if (!s) return null;
  let t = new Date(s).getTime();
  if (Number.isNaN(t)) t = new Date(String(s).replace(" ", "T")).getTime();
  return Number.isNaN(t) ? null : t;
}

function fmtClock(d) {
  return d.toLocaleTimeString("vi-VN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh", hour12: false,
  });
}

function fmtDayLabel(tab) {
  const p = String(tab).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : tab;
}

function safeUrl(u) {
  const s = str(u);
  return /^https?:\/\//i.test(s) ? s : "";
}

/** Giai đoạn pipeline của một dòng video. */
function rowStage(r, c) {
  const s = norm(r[c.status]);
  const note = norm(r[c.note] || "");
  const url = str(r[c.url]);
  if (s === "ĐÃ ĐĂNG") return "published";
  if (s === "CHỜ QA") return "qa";
  if (s === "ĐANG DỰNG") return "building";
  if (note.includes("BẢN NHÁP") || note.includes("CHỜ ĐĂNG") || (!s && url)) return "ready";
  return "building"; // chưa bắt đầu -> đầu phễu
}

/* ---------- data loading ---------- */
function dateRange() {
  const out = [];
  const d = new Date(START_DATE + "T00:00:00");
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  while (d <= today) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

async function fetchTab(tab, channel = "ttbd") {
  const r = await fetch(`${API}?tab=${encodeURIComponent(tab)}&channel=${channel}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "unknown");
  const data = {
    summary: j.summary || { total: 0, building: 0, qa: 0, published: 0 },
    columns: j.columns || [],
    rows: j.rows || [],
  };
  if (channel === "ttbd") cache.set(tab, data);
  return data;
}

/** Tải tab "KPI Kênh" (dữ liệu thô, độc lập với các tab ngày). */
async function fetchKpiTab() {
  try {
    const r = await fetch(`${API}?tab=${encodeURIComponent("KPI Kênh")}`);
    const j = await r.json();
    if (!j.ok || j.type !== "kpi") throw new Error(j.error || "unknown");
    kpiChannelData = { columns: j.columns || [], rows: j.rows || [] };
  } catch (e) {
    kpiChannelData = null;
  }
}

/** Tải tab "Tiến độ render" (độc lập, lỗi không chặn các khối khác). */
async function fetchProgressTab() {
  try {
    const r = await fetch(`${API}?tab=${encodeURIComponent("Tiến độ render")}`);
    const j = await r.json();
    if (!j.ok || j.type !== "progress") throw new Error(j.error || "unknown");
    prodData = { columns: j.columns || [], rows: j.rows || [] };
  } catch (e) {
    prodData = null;
  }
}

/** Tải song song toàn bộ tab ngày, cache trong memory. */
async function loadAllTabs() {
  const dates = dateRange();
  const results = await Promise.allSettled(
    dates.map(async (tab) => {
      try {
        await fetchTab(tab);
        return tab;
      } catch (e) {
        return null;
      }
    })
  );
  availableTabs = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .sort();
}

function buildDayTabs() {
  const wrap = $("dayTabs");
  wrap.innerHTML = "";
  if (availableTabs.length === 0) {
    wrap.innerHTML = '<span class="card-head-meta">Chưa có dữ liệu ngày nào</span>';
    return;
  }
  availableTabs.forEach((tab) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "day-tab" + (tab === currentTab ? " active" : "");
    b.dataset.tab = tab;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(tab === currentTab));
    b.textContent = fmtDayLabel(tab);
    b.title = `Xem chi tiết ngày ${tab}`;
    b.addEventListener("click", () => selectTab(tab));
    wrap.appendChild(b);
  });
}

async function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".day-tab").forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  if (!cache.has(tab)) {
    try { await fetchTab(tab); } catch (e) { /* giữ nguyên bảng cũ */ }
  }
  renderTable();
}

async function refreshAll() {
  if (fetching) return;
  fetching = true;
  $("btnRefresh").disabled = true;
  try {
    await loadAllTabs();
  } catch (e) {
    /* rớt mạng: giữ cache cũ, vẫn render + hiện STALE */
  }
  try {
    await fetchKpiTab();
  } catch (e) {
    /* KPI kênh lỗi: giữ trạng thái cũ */
  }
  try {
    await fetchProgressTab();
  } catch (e) {
    /* Tiến độ render lỗi: giữ trạng thái cũ */
  }
  if (!availableTabs.includes(currentTab)) {
    currentTab = availableTabs.length ? availableTabs[availableTabs.length - 1] : null;
  }
  buildDayTabs();
  const ok = availableTabs.length > 0;
  if (ok) {
    lastSuccessAt = Date.now();
    $("lastUpdated").textContent = fmtClock(new Date());
    hideError();
  } else {
    showError();
  }
  renderAll();
  updateStale();
  countdown = REFRESH_SEC;
  updateCountdown();
  fetching = false;
  $("btnRefresh").disabled = false;
}

/* ---------- render ---------- */
function renderAll() {
  const all = availableTabs
    .map((tab) => ({ tab, data: cache.get(tab) }))
    .filter((x) => x.data);
  if (!all.length) return;
  attentionItems = collectAttention(all);
  renderKPIs(all);
  renderKpiChannel();
  renderFunnel(all);
  renderChart(all);
  renderAttention();
  renderContentScan(all);
  renderTable();
  renderProduction();
}

function renderKPIs(all) {
  let total = 0, pub = 0;
  for (const { data } of all) {
    total += data.summary.total || 0;
    pub += data.summary.published || 0;
  }
  const newest = all[all.length - 1];
  const rate = total > 0 ? Math.round((pub / total) * 100) : 0;

  $("kpiTotal").textContent = total;
  $("kpiRate").textContent = rate + "%";
  $("kpiRateSub").textContent = `${pub}/${total} video`;
  $("rateBar").style.width = rate + "%";
  $("rateBarWrap").setAttribute("aria-valuenow", String(rate));

  $("kpiTodayPublished").textContent = newest ? newest.data.summary.published || 0 : "—";
  $("kpiTodayLabel").textContent = newest ? `ngày ${fmtDayLabel(newest.tab)}` : "";
  $("kpiBuilding").textContent = newest ? newest.data.summary.building || 0 : "—";

  const n = attentionItems.length;
  $("kpiAttentionCount").textContent = n;
  $("kpiAttention").classList.toggle("has-issues", n > 0);
}

const STAGES = [
  { key: "building", name: "Đang dựng" },
  { key: "qa", name: "Chờ QA" },
  { key: "ready", name: "Chờ đăng" },
  { key: "published", name: "Đã đăng" },
];

function renderFunnel(all) {
  const f = { building: 0, qa: 0, ready: 0, published: 0 };
  for (const { data } of all) {
    const c = colIdx(data.columns);
    for (const r of data.rows) f[rowStage(r, c)]++;
  }
  const total = f.building + f.qa + f.ready + f.published;
  const arrow = '<span class="funnel-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span>';
  $("funnel").innerHTML = STAGES.map((s, i) => {
    const n = f[s.key];
    const pct = total > 0 ? Math.round((n / total) * 100) : 0;
    return `${i > 0 ? arrow : ""}
      <div class="funnel-stage stage-${s.key}">
        <div class="stage-name">${s.name}</div>
        <div class="stage-count">${n}</div>
        <div class="stage-bar" role="img" aria-label="${s.name}: ${n} video (${pct}%)"><div style="width:${pct}%"></div></div>
      </div>`;
  }).join("");
}

function renderChart(all) {
  const el = $("chart");
  const maxPub = Math.max(0, ...all.map((a) => a.data.summary.published || 0));
  const scale = Math.max(TARGET_PER_DAY, maxPub, 1);
  const targetPx = (160 * TARGET_PER_DAY) / scale;
  let html = `<div class="chart-target" style="bottom:calc(26px + ${targetPx.toFixed(1)}px)" aria-hidden="true"><span>Mục tiêu ${TARGET_PER_DAY}/ngày</span></div>`;
  html += all.map(({ tab, data }) => {
    const p = data.summary.published || 0;
    const h = p > 0 ? Math.max((160 * p) / scale, 4) : 0;
    const label = fmtDayLabel(tab);
    return `<div class="bar-col" tabindex="0" aria-label="Ngày ${label}: ${p} video đã đăng">
      <div class="bar-value">${p}</div>
      <div class="bar-track">
        <div class="bar-fill${p < TARGET_PER_DAY ? " low" : ""}" style="height:${h.toFixed(1)}px"></div>
        <div class="bar-tip" role="tooltip"><strong>${esc(label)}</strong><br>Tổng: ${data.summary.total || 0} · Đang dựng: ${data.summary.building || 0}<br>Đã đăng: ${p}</div>
      </div>
      <div class="bar-label">${esc(label)}</div>
    </div>`;
  }).join("");
  el.innerHTML = html;
}

function collectAttention(all) {
  const items = [];
  const now = Date.now();
  for (const { tab, data } of all) {
    const c = colIdx(data.columns);
    for (const r of data.rows) {
      const code = str(r[c.code]);
      const title = str(r[c.title]);
      const status = norm(r[c.status]);
      const note = str(r[c.note]);
      const url = str(r[c.url]);
      const label = code && title ? `${code} — ${title}` : code || title || "(không rõ)";

      if (status === "ĐÃ ĐĂNG" && norm(note).includes("CHƯA GẮN THUMBNAIL")) {
        items.push({
          sev: "medium",
          title: "Chờ gắn thumbnail custom",
          desc: `${label} — gắn bổ sung khi kênh được duyệt xác minh.`,
          code, tab,
        });
      }
      if (status === "ĐANG DỰNG") {
        const t = parseUpdateTime(r[c.updated]);
        if (t) {
          const hours = (now - t) / 36e5;
          if (hours > STUCK_HOURS) {
            items.push({
              sev: hours > STUCK_HOURS * 2 ? "high" : "medium",
              title: `Đang dựng quá ${Math.round(hours)} giờ, có thể bị tắc`,
              desc: label,
              code, tab,
            });
          }
        }
      }
      if ((status === "ĐÃ ĐĂNG" || status === "CHỜ QA") && !url) {
        items.push({ sev: "high", title: "Thiếu URL video", desc: label, code, tab });
      }
    }
  }
  const newest = all[all.length - 1];
  if (newest && (newest.data.summary.total || 0) > 0 && (newest.data.summary.published || 0) === 0) {
    items.push({
      sev: "medium",
      title: `Ngày ${fmtDayLabel(newest.tab)} chưa đăng video nào`,
      desc: `${newest.data.summary.total} video trong kỳ, 0 đã đăng.`,
      code: "", tab: newest.tab,
    });
  }
  const rank = { high: 0, medium: 1 };
  items.sort((a, b) => rank[a.sev] - rank[b.sev]);
  return items;
}

function renderAttention() {
  const list = $("attentionList");
  $("attentionMeta").textContent = attentionItems.length
    ? `${attentionItems.length} việc`
    : "";
  if (attentionItems.length === 0) {
    list.innerHTML = '<li class="attention-empty">Mọi thứ đang trôi chảy — không có việc tồn đọng.</li>';
    return;
  }
  list.innerHTML = attentionItems.map((it) => `
    <li class="attention-item sev-${it.sev}">
      <span class="sev-badge">${it.sev === "high" ? "CAO" : "TRUNG BÌNH"}</span>
      <div class="attention-body">
        <div class="attention-title">${esc(it.title)}</div>
        <div class="attention-desc">${it.code ? `<span class="attention-code">${esc(it.code)}</span> · ` : ""}${esc(it.desc)}${it.tab ? ` <span class="attention-code">(${esc(fmtDayLabel(it.tab))})</span>` : ""}</div>
      </div>
    </li>`).join("");
}

/* ---------- KPI xây kênh ---------- */
function kpiNum(v) {
  const n = parseInt(String(v == null ? "" : v).replace(/[^\d]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function renderKpiChannel() {
  const data = kpiChannelData;
  const fmtN = (n) => (n == null ? "—" : n.toLocaleString("vi-VN"));
  if (!data || !data.rows.length) {
    $("kpiSubs").textContent = "—";
    $("kpiViews").textContent = "—";
    $("kpiVideos").textContent = "—";
    $("kpiSubsSub").textContent = "";
    $("kpiViewsSub").textContent = "";
    $("kpiVideosDate").textContent = "";
    $("yppSubsPct").textContent = "—";
    $("kpiChart").innerHTML = '<div class="mini-chart-empty">Chưa có số liệu — hệ thống sẽ tự chụp mỗi sáng 8h.</div>';
    $("kpiEmptyNote").textContent = "";
    return;
  }
  const cols = data.columns;
  const iDate = colIndex(cols, "Ngày", 0);
  const iSubs = colIndex(cols, "Subs", 1);
  const iViews = colIndex(cols, "Views 28 ngày", 2);
  const iVideos = colIndex(cols, "Tổng video", 3);
  const rows = data.rows.map((r) => ({
    date: str(r[iDate]),
    subs: kpiNum(r[iSubs]),
    views: kpiNum(r[iViews]),
    videos: kpiNum(r[iVideos]),
  }));
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;

  $("kpiSubs").textContent = fmtN(last.subs);
  const pct = last.subs != null ? Math.min(100, Math.round((last.subs / 1000) * 100)) : 0;
  $("kpiSubsSub").textContent = last.subs != null ? `${pct}% mục tiêu 1.000 subs` : "";
  $("subsBar").style.width = pct + "%";
  $("subsBarWrap").setAttribute("aria-valuenow", String(pct));
  $("yppSubsPct").textContent = last.subs != null ? pct + "%" : "—";
  $("yppSubsBar").style.width = pct + "%";
  $("yppSubsBarWrap").setAttribute("aria-valuenow", String(pct));

  $("kpiViews").textContent = fmtN(last.views);
  let deltaTxt = "";
  if (last.views != null && prev && prev.views != null) {
    const d = last.views - prev.views;
    deltaTxt = (d >= 0 ? "+" : "") + fmtN(d) + " so với snapshot trước";
  }
  $("kpiViewsSub").textContent = deltaTxt;

  $("kpiVideos").textContent = fmtN(last.videos);
  $("kpiVideosDate").textContent = last.date ? `snapshot ${last.date}` : "";

  const maxSubs = Math.max(1, ...rows.map((r) => r.subs || 0));
  $("kpiChart").innerHTML = rows
    .map((r) => {
      const h = r.subs ? Math.max((100 * r.subs) / maxSubs, 4) : 0;
      const lbl = r.date ? r.date.slice(5) : "";
      return `<div class="mini-bar-col" tabindex="0" aria-label="Ngày ${esc(r.date)}: ${fmtN(r.subs)} subs">
        <div class="mini-bar-value">${fmtN(r.subs)}</div>
        <div class="mini-bar-track"><div class="mini-bar-fill" style="height:${h.toFixed(1)}px"></div>
        <div class="mini-bar-tip" role="tooltip"><strong>${esc(r.date || "?")}</strong><br>Subs: ${fmtN(r.subs)}<br>Views 28d: ${fmtN(r.views)}<br>Video: ${fmtN(r.videos)}</div></div>
        <div class="mini-bar-label">${esc(lbl)}</div>
      </div>`;
    })
    .join("");
  $("kpiEmptyNote").textContent =
    rows.length < 2
      ? "Số liệu sẽ được chụp tự động mỗi sáng 8h — biểu đồ đầy dần theo thời gian."
      : `Đã có ${rows.length} snapshot · mới nhất ${last.date || ""}`;
}

/* ---------- Quét nội dung: chấm điểm SEO ---------- */
function seoScore(r, c) {
  const title = str(r[c.title]);
  const keyword = str(r[c.keyword]);
  const note = norm(r[c.note] || "");
  const url = str(r[c.url]);
  let score = 0;
  const fails = [];

  // Tiêu đề ≤ 100 ký tự: +25 (dài hơn: +10)
  if (title.length <= 100) score += 25;
  else {
    score += 10;
    fails.push("tiêu đề dài hơn 100 ký tự");
  }

  // Từ khóa trong tiêu đề: +15; nằm ở đầu (15 ký tự đầu): +15
  const kw = keyword.toLowerCase();
  const t = title.toLowerCase();
  if (!kw) {
    fails.push("chưa có từ khóa mục tiêu");
  } else {
    const idx = t.indexOf(kw);
    if (idx < 0) {
      fails.push("từ khóa không xuất hiện trong tiêu đề");
    } else {
      score += 15;
      if (idx < 15) score += 15;
      else fails.push("từ khóa không nằm đầu tiêu đề");
    }
  }

  // Thumbnail custom: +25
  if (note.includes("CHƯA GẮN THUMBNAIL")) {
    fails.push("thiếu thumbnail custom");
  } else {
    score += 25;
  }

  // URL YouTube: +20
  if (url) score += 20;
  else fails.push("thiếu URL YouTube");

  return { score, fails };
}

function renderContentScan(all) {
  const extIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const items = [];
  for (const { tab, data } of all) {
    const c = colIdx(data.columns);
    for (const r of data.rows) {
      if (rowStage(r, c) !== "published") continue;
      const { score, fails } = seoScore(r, c);
      items.push({
        score,
        fails,
        code: str(r[c.code]),
        title: str(r[c.title]),
        url: safeUrl(r[c.url]),
        tab,
      });
    }
  }
  items.sort((a, b) => a.score - b.score); // yếu nhất lên đầu
  $("seoAvg").textContent = items.length
    ? Math.round(items.reduce((s, x) => s + x.score, 0) / items.length)
    : "—";
  const list = $("seoList");
  if (items.length === 0) {
    list.innerHTML = '<li class="attention-empty">Chưa có video nào đã đăng.</li>';
    return;
  }
  list.innerHTML = items
    .map((it) => {
      const cls = it.score >= 80 ? "score-green" : it.score >= 50 ? "score-amber" : "score-red";
      const titleHtml = it.url
        ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}${extIcon}</a>`
        : esc(it.title);
      const failsHtml = it.fails.length
        ? `<ul class="seo-fails">${it.fails.map((f) => `<li class="seo-fail">${esc(f)}</li>`).join("")}</ul>`
        : '<div class="seo-ok">Đạt mọi tiêu chí kiểm tra</div>';
      return `<li class="seo-item">
        <span class="seo-score ${cls}" aria-label="Điểm SEO ${it.score} trên 100">${it.score}</span>
        <div class="seo-body">
          <div class="seo-title">${titleHtml}</div>
          <div class="seo-code">${esc(it.code)}${it.tab ? ` · ${esc(fmtDayLabel(it.tab))}` : ""}</div>
          <div class="seo-bar" role="img" aria-label="Điểm SEO ${it.score} trên 100"><div class="${cls}" style="width:${it.score}%"></div></div>
          ${failsHtml}
        </div>
      </li>`;
    })
    .join("");
}

function statusBadge(stage) {
  if (stage === "published") return '<span class="badge badge-published">ĐÃ ĐĂNG</span>';
  if (stage === "qa") return '<span class="badge badge-qa">CHỜ QA</span>';
  if (stage === "ready") return '<span class="badge badge-ready">CHỜ ĐĂNG</span>';
  if (stage === "building") return '<span class="badge badge-building">ĐANG DỰNG</span>';
  return '<span class="badge badge-none">—</span>';
}

function thumbBadge(stage, note) {
  if (norm(note).includes("CHƯA GẮN THUMBNAIL"))
    return '<span class="badge badge-thumb-wait">Chờ duyệt</span>';
  if (stage === "published")
    return '<span class="badge badge-thumb-ok">Đã gắn</span>';
  return '<span class="badge badge-none">—</span>';
}

function renderTable() {
  renderDaySummary();
  const body = $("workTableBody");
  const data = currentTab ? cache.get(currentTab) : null;
  if (!data) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Chưa có dữ liệu ngày này.</td></tr>';
    return;
  }
  const c = colIdx(data.columns);
  const rows = data.rows;
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Chưa có video nào trong ngày này.</td></tr>';
    return;
  }
  const extIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  body.innerHTML = rows.map((r) => {
    const code = str(r[c.code]);
    const title = str(r[c.title]);
    const url = safeUrl(r[c.url]);
    const note = str(r[c.note]);
    const stage = rowStage(r, c);
    const titleHtml = url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(title)}${extIcon}</a>`
      : esc(title);
    return `<tr>
      <td class="code">${esc(code)}</td>
      <td class="title">${titleHtml}</td>
      <td>${statusBadge(stage)}</td>
      <td class="keyword">${esc(r[c.keyword])}</td>
      <td class="updated">${esc(r[c.updated])}</td>
      <td>${thumbBadge(stage, note)}</td>
      <td class="note" title="${esc(note)}">${esc(note)}</td>
    </tr>`;
  }).join("");
}

/* Dải tóm tắt của ngày đang chọn — đi cùng bộ lọc tab ngày */
function renderDaySummary() {
  const el = $("daySummary");
  const data = currentTab ? cache.get(currentTab) : null;
  if (!data) { el.innerHTML = ""; return; }
  const s = data.summary || {};
  const items = [
    ["Tổng video", s.total || 0, ""],
    ["Đang dựng", s.building || 0, "warn"],
    ["Chờ QA", s.qa || 0, "warn"],
    ["Đã đăng", s.published || 0, "ok"],
  ];
  el.innerHTML =
    `<span class="day-summary-label">${esc(fmtDayLabel(currentTab))}</span>` +
    items.map(([l, v, cls]) =>
      `<span class="day-summary-item"><span class="day-summary-num ${cls}">${v}</span><span class="day-summary-cap">${l}</span></span>`
    ).join("");
}

/* ---------- Tiến độ sản xuất (tab "Tiến độ render") ---------- */
const PROD_COLS = ["Cập nhật lúc", "Mã video", "Tiêu đề", "Giai đoạn", "Tiến độ %", "Bắt đầu", "Dự kiến xong", "Ghi chú"];

function prodRows() {
  if (!prodData || !prodData.rows) return [];
  const idx = (name) => {
    const i = (prodData.columns || []).findIndex((c) => norm(c) === norm(name));
    return i >= 0 ? i : -1;
  };
  const ci = PROD_COLS.map(idx);
  return prodData.rows
    .map((r) => PROD_COLS.map((_, k) => (ci[k] >= 0 ? str(r[ci[k]]) : "")))
    .filter((r) => r.some((c) => c !== ""));
}

function renderProduction() {
  const body = $("prodBody");
  const meta = $("prodUpdated");
  const rows = prodRows();
  if (!rows.length) {
    if (meta) meta.textContent = "";
    body.innerHTML = '<p class="empty">Chưa có dữ liệu tiến độ render.</p>';
    return;
  }
  // Dòng timestamp: cột "Mã video" trống nhưng "Cập nhật lúc" có giá trị
  const tsRow = rows.find((r) => !r[1] && r[0]);
  if (meta) meta.textContent = tsRow ? `Dữ liệu lúc ${tsRow[0]}` : "";
  const videos = rows.filter((r) => r[1] || norm(r[3]) === "HOÀN TẤT");
  const running = videos.find((r) => norm(r[3]) === "ĐANG RENDER");
  const waiting = videos.filter((r) => norm(r[3]) === "CHỜ RENDER");
  const done = videos.find((r) => norm(r[3]) === "HOÀN TẤT");

  let html = "";
  if (running) {
    const pct = Math.max(0, Math.min(99, parseInt(running[4], 10) || 0));
    const mRun = running[7].match(/đã chạy\s*(\d+)\s*phút/);
    const elapsed = mRun ? mRun[1] : String(Math.round((pct / 100) * 45));
    const mPos = running[7].match(/video thứ\s*(\d+)\/(\d+)/);
    const pos = mPos ? `Video thứ ${mPos[1]}/${mPos[2]}` : "";
    html += `<div class="prod-hero">
      <div class="prod-hero-top">
        <span class="prod-code">${esc(running[1])}</span>
        <span class="prod-badge-render" aria-label="Đang render">ĐANG RENDER</span>
      </div>
      <div class="prod-title" title="${esc(running[2])}">${esc(running[2])}</div>
      <div class="progress" role="progressbar" aria-label="Tiến độ render" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div class="progress-fill progress-fill-brand" style="width:${pct}%"></div>
      </div>
      <div class="prod-meta">
        <span><strong>${pct}%</strong> · Đã chạy ${esc(elapsed)} phút · Dự kiến xong lúc <strong>${esc(running[6] || "—")}</strong></span>
        ${pos ? `<span class="prod-pos">${esc(pos)}</span>` : ""}
      </div>
    </div>`;
  } else if (done) {
    html += `<div class="prod-done">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>
      <span>${esc(done[2] || "Đã hoàn tất toàn bộ")}</span>
    </div>`;
  } else {
    html += `<p class="empty">Hiện không có video nào đang render.</p>`;
  }

  if (waiting.length) {
    const shown = waiting.slice(0, 6);
    html += `<ul class="prod-queue" aria-label="Hàng chờ render">` + shown.map((r) =>
      `<li><span class="prod-qcode">${esc(r[1])}</span>` +
      `<span class="prod-qtitle" title="${esc(r[2])}">${esc(r[2])}</span>` +
      `<span class="prod-qeta">dự kiến ${esc(r[6] || "—")}</span></li>`
    ).join("") + `</ul>`;
    if (waiting.length > shown.length) {
      html += `<p class="prod-more">…và ${waiting.length - shown.length} video nữa trong hàng chờ</p>`;
    }
  }
  body.innerHTML = html;
}

/* ---------- header: clock / countdown / stale / pause ---------- */
function tickClock() {
  $("clock").textContent = fmtClock(new Date());
}

function updateCountdown() {
  const el = $("countdown");
  if (el) el.textContent = paused ? "—" : countdown;
}

function tickSecond() {
  tickClock();
  if (!paused && !fetching) {
    countdown -= 1;
    if (countdown <= 0) {
      refreshAll();
      return;
    }
    updateCountdown();
  }
  updateStale();
}

function updateStale() {
  const stale = lastSuccessAt > 0 && Date.now() - lastSuccessAt > STALE_MS;
  $("staleBadge").classList.toggle("hidden", !stale);
}

function setPaused(p) {
  paused = p;
  $("pauseLabel").textContent = paused ? "Tiếp tục" : "Tạm dừng";
  $("pauseIcon").classList.toggle("hidden", paused);
  $("playIcon").classList.toggle("hidden", !paused);
  $("btnPause").setAttribute("aria-pressed", String(paused));
  $("btnPause").title = paused ? "Tiếp tục tự động làm mới" : "Tạm dừng tự động làm mới";
  $("liveBadge").classList.toggle("paused", paused);
  $("liveText").textContent = paused ? "TẠM DỪNG" : "LIVE";
  $("countdownPrefix").textContent = paused ? "Tự động làm mới đã tạm dừng" : "Tự động làm mới sau";
  if (!paused) {
    countdown = REFRESH_SEC;
    refreshAll();
  } else {
    updateCountdown();
  }
}

/* ---------- error ---------- */
function showError() { $("errorBox").classList.remove("hidden"); }
function hideError() { $("errorBox").classList.add("hidden"); }

/* ---------- Redrawn Borders ---------- */
async function fetchRbPipeline() {
  try {
    const r = await fetch(`${API}?tab=${encodeURIComponent("Video Pipeline")}&channel=rb`);
    const j = await r.json();
    if (!j.ok || j.type !== "rb-pipeline") throw new Error(j.error || "unknown");
    rbPipelineData = { columns: j.columns || [], rows: j.rows || [] };
  } catch (e) {
    rbPipelineData = null;
  }
}

function renderRbView() {
  const data = rbPipelineData;
  const body = $("rbTableBody");
  if (!data || !data.rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Chưa có dữ liệu pipeline.</td></tr>';
    $("rbTotal").textContent = "—";
    $("rbPublished").textContent = "—";
    $("rbWorking").textContent = "—";
    return;
  }
  // Bỏ các hàng header/tóm tắt, chỉ lấy hàng có số thứ tự ở cột đầu
  const videos = data.rows.filter((r) => /^\d+$/.test(str(r[0]).trim()));
  let pub = 0, working = 0;
  const rowsHtml = videos.map((r) => {
    const num = str(r[0]), title = str(r[1]), pillar = str(r[2]),
          kw = str(r[3]), week = str(r[4]), status = str(r[5]);
    const st = norm(status);
    let badge;
    if (st.includes("ĐÃ ĐĂNG") || st.includes("HOÀN THÀNH")) { badge = '<span class="badge badge-published">ĐÃ ĐĂNG</span>'; pub++; }
    else if (st.includes("ĐANG")) { badge = '<span class="badge badge-building">ĐANG LÀM</span>'; working++; }
    else { badge = '<span class="badge badge-none">CHƯA LÀM</span>'; }
    return `<tr><td class="code">${esc(num)}</td><td class="title">${esc(title)}</td>` +
      `<td>${esc(pillar)}</td><td class="keyword">${esc(kw)}</td><td>${esc(week)}</td><td>${badge}</td></tr>`;
  }).join("");
  body.innerHTML = rowsHtml || '<tr><td colspan="6" class="empty">Chưa có video trong pipeline.</td></tr>';
  $("rbTotal").textContent = videos.length;
  $("rbPublished").textContent = pub;
  $("rbWorking").textContent = working;
  // Subs: đọc từ tab KPI của RB nếu có (tạm để —)
  $("rbSubs").textContent = "—";
}

/* ---------- Channel switching ---------- */
function switchChannel(ch) {
  currentChannel = ch;
  document.querySelectorAll(".channel-tab").forEach((b) => {
    const active = b.dataset.channel === ch;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".channel-view").forEach((v) => {
    v.classList.toggle("active", v.id === "view-" + ch);
  });
  if (ch === "rb" && !rbPipelineData) {
    fetchRbPipeline().then(renderRbView);
  } else if (ch === "rb") {
    renderRbView();
  }
  document.title = ch === "rb" ? "Redrawn Borders — Trung tâm điều hành" : "Tin Trên Bản Đồ — Trung tâm điều hành";
}

/* ---------- Production stage tabs (TTBD) ---------- */
function switchStage(stage) {
  currentStage = stage;
  document.querySelectorAll(".prod-tab").forEach((b) => {
    const active = b.dataset.stage === stage;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  renderProdStage();
}

function renderProdStage() {
  const body = $("prodStageBody");
  if (!body) return;
  const all = availableTabs.map((tab) => ({ tab, data: cache.get(tab) })).filter((x) => x.data);

  if (currentStage === "producing") {
    // Dùng lại renderProduction nhưng render vào prodStageBody
    const prodEl = $("prodBody");
    if (prodEl) body.innerHTML = prodEl.innerHTML;
    else body.innerHTML = '<p class="empty">Chưa có dữ liệu sản xuất.</p>';
    return;
  }

  // queue: video CHỜ ĐĂNG (draft-ready / có URL nháp nhưng chưa public)
  // published: video ĐÃ ĐĂNG (có URL công khai)
  const items = [];
  for (const { tab, data } of all) {
    const c = colIdx(data.columns);
    for (const r of data.rows) {
      const stage = rowStage(r, c);
      const note = str(r[c.note] || "");
      const url = str(r[c.url] || "");
      const isDraft = /studio\.youtube\.com\/video\//i.test(url) || /BẢN NHÁP/i.test(note);
      if (currentStage === "queue" && (stage === "ready" || isDraft)) {
        items.push({ tab, code: str(r[c.code]), title: str(r[c.title]), keyword: str(r[c.keyword]), updated: str(r[c.updated]), url, note });
      } else if (currentStage === "published" && stage === "published" && !isDraft) {
        items.push({ tab, code: str(r[c.code]), title: str(r[c.title]), keyword: str(r[c.keyword]), updated: str(r[c.updated]), url, note });
      }
    }
  }
  // Mới nhất lên đầu
  items.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));

  if (!items.length) {
    const label = currentStage === "queue" ? "Chưa có video nào đang chờ đăng." : "Chưa có video nào đã đăng.";
    body.innerHTML = `<p class="empty">${label}</p>`;
    return;
  }
  const shown = items.slice(0, 20);
  body.innerHTML = `<div class="table-wrap"><table><thead><tr>` +
    `<th>Mã</th><th>Tiêu đề</th><th>Từ khóa</th><th>Cập nhật</th><th>Link</th>` +
    `</tr></thead><tbody>` +
    shown.map((it) => `<tr><td class="code">${esc(it.code)}</td>` +
      `<td class="title">${esc(it.title)}</td><td class="keyword">${esc(it.keyword)}</td>` +
      `<td class="updated">${esc(it.updated)}</td>` +
      `<td>${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">Mở</a>` : "—"}</td></tr>`).join("") +
    `</tbody></table></div>` +
    (items.length > shown.length ? `<p class="prod-more">…và ${items.length - shown.length} video nữa</p>` : "");
}

/* ---------- init ---------- */
$("btnRefresh").addEventListener("click", () => refreshAll());
$("btnPause").addEventListener("click", () => setPaused(!paused));
$("kpiAttention").addEventListener("click", () => {
  const panel = $("attentionPanel");
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  panel.focus({ preventScroll: true });
});
document.querySelectorAll(".channel-tab").forEach((b) => {
  b.addEventListener("click", () => switchChannel(b.dataset.channel));
});
document.querySelectorAll(".prod-tab").forEach((b) => {
  b.addEventListener("click", () => switchStage(b.dataset.stage));
});

// Render lại tab tiến độ sau mỗi lần refresh dữ liệu
const _renderAll = renderAll;
renderAll = function () {
  _renderAll();
  renderProdStage();
};

setInterval(tickSecond, 1000);
tickClock();
refreshAll();
