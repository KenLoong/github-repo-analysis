"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 本地存储(密钥一粘贴就保存) ----------
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
let HAS_LLM = false;
const PERSIST = { repo: "gh.repo" };

function bindPersist(id, key, hintId) {
  const el = $(id);
  el.value = store.get(key) || el.value;
  const save = () => {
    const v = el.value.trim();
    store.set(key, v);
    if (hintId) $(hintId).textContent = v ? "✓ 已保存" : "";
  };
  el.addEventListener("input", save);
  el.addEventListener("paste", () => setTimeout(save, 0));
  el.addEventListener("change", save);
  save();
}
bindPersist("repo", PERSIST.repo);

// 密钥与默认值来自服务器读取的 config.json;输入框仅作临时覆盖,不落盘
(async () => {
  try {
    const c = await (await fetch("/api/config", { cache: "no-store" })).json();
    if (c.github_token) { $("ghToken").value = c.github_token; $("ghSaved").textContent = "✓ 来自 config.json"; }
    HAS_LLM = !!c.deepseek_configured;
    $("gmSaved").textContent = HAS_LLM ? "✓ 来自 config.json" : "未配置 deepseek_api_key";
    if (c.deepseek_model) $("model").value = c.deepseek_model;
    if (c.default_repo && !$("repo").value) $("repo").value = c.default_repo;
    if (c.max_commits) $("maxCommits").value = c.max_commits;
    if (c.max_items) $("maxItems").value = c.max_items;
    if (c.max_comment_pages) $("maxCommentPages").value = c.max_comment_pages;
  } catch {}
})();

// ---------- 进度 / 错误 ----------
function setStatus(msg, pct) {
  $("status").textContent = msg;
  if (pct != null) { $("barWrap").hidden = false; $("bar").style.width = Math.round(pct) + "%"; }
}
function showError(msg) { $("error").hidden = !msg; $("error").textContent = msg || ""; }

// ---------- GitHub ----------
function parseRepo(url) {
  const m = url.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i) || url.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error("无法解析 repo 链接,格式应为 https://github.com/owner/repo");
  return { owner: m[1], repo: m[2] };
}

async function ghFetch(path, token) {
  const res = await fetch("https://api.github.com" + path, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch {}
    if (res.status === 401) throw new Error("GitHub token 无效或已过期(401)");
    if (res.status === 404) throw new Error("找不到该 repo,或 token 没有访问权限(404)");
    if (res.status === 403 || res.status === 429) throw new Error("GitHub 限流或无权限(" + res.status + "): " + detail);
    throw new Error("GitHub 请求失败 " + res.status + ": " + detail);
  }
  return res.json();
}

// 分页拉取,最多 maxItems 条 / maxPages 页
async function ghList(path, token, { maxItems = Infinity, maxPages = Infinity, label = "" } = {}) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages && out.length < maxItems; page++) {
    const data = await ghFetch(`${path}${sep}per_page=100&page=${page}`, token);
    out.push(...data);
    if (label) setStatus(`正在拉取 ${label}… ${Math.min(out.length, maxItems)}`);
    if (data.length < 100) break;
  }
  return out.slice(0, maxItems);
}

async function fetchRepoData(cfg) {
  const { owner, repo, token, maxCommits, maxItems, maxCommentPages } = cfg;
  const base = `/repos/${owner}/${repo}`;
  await ghFetch(base, token); // 先校验 repo / token

  setStatus("正在拉取 commits…", 5);
  const rawCommits = await ghList(`${base}/commits`, token, { maxItems: maxCommits, label: "commits" });
  const commits = rawCommits.map((c) => ({
    id: c.sha,
    sha: c.sha,
    author: c.author?.login || c.commit.author?.name || "(unknown)",
    message: c.commit.message || "",
    url: c.html_url,
    date: c.commit.author?.date || "",
  }));

  setStatus("正在拉取 issues / PRs…", 15);
  // /issues 同时返回 PR,用 pull_request 字段区分
  const rawIssues = await ghList(`${base}/issues?state=all&sort=created&direction=desc`, token, { maxItems: maxItems * 3, maxPages: Math.ceil(maxItems / 100) * 3, label: "issues" });
  const mapItem = (x, kind) => ({
    id: `${kind}${x.number}`,
    kind,
    number: x.number,
    title: x.title,
    body: x.body || "",
    labels: (x.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
    author: x.user?.login || "(unknown)",
    url: x.html_url,
    state: x.state,
    updated: x.updated_at,
    merged: !!x.pull_request?.merged_at,
  });
  const issues = rawIssues.filter((x) => !x.pull_request).slice(0, maxItems).map((x) => mapItem(x, "i"));
  const prs = rawIssues.filter((x) => x.pull_request).slice(0, maxItems).map((x) => mapItem(x, "p"));

  setStatus("正在拉取评论…", 30);
  const [issueCmts, reviewCmts] = await Promise.all([
    ghList(`${base}/issues/comments?sort=created&direction=desc`, token, { maxPages: maxCommentPages, label: "issue/PR 评论" }),
    ghList(`${base}/pulls/comments?sort=created&direction=desc`, token, { maxPages: maxCommentPages, label: "PR review 评论" }),
  ]);
  // issues/comments 接口里 PR 的对话评论也在内,用 html_url 区分
  const comments = [];
  for (const c of issueCmts) {
    const m = c.html_url.match(/\/(issues|pull)\/(\d+)#/);
    if (!m || !c.user) continue;
    comments.push({ author: c.user.login, kind: m[1] === "pull" ? "p" : "i", number: +m[2] });
  }
  for (const c of reviewCmts) {
    const m = (c.pull_request_url || "").match(/\/pulls\/(\d+)$/);
    if (!m || !c.user) continue;
    comments.push({ author: c.user.login, kind: "p", number: +m[1] });
  }

  // 列表接口不含行数,需逐个 commit 请求 stats(并发 + 缓存)
  let done = 0;
  await runPool(commits.map((c) => async () => {
    const hit = cacheGet(cfg, "s:" + c.sha);
    if (hit) { c.stats = hit; return; }
    try {
      const d = await ghFetch(`${base}/commits/${c.sha}`, token);
      c.stats = { add: d.stats?.additions ?? 0, del: d.stats?.deletions ?? 0 };
      cacheSet(cfg, "s:" + c.sha, c.stats);
    } catch (e) { if (/限流|401/.test(e.message)) throw e; }
  }), 6, () => { done++; if (done % 5 === 0 || done === commits.length) setStatus(`正在拉取 commit 行数… ${done}/${commits.length}`, 30 + (10 * done) / commits.length); });

  return { commits, issues, prs, comments };
}

// ---------- DeepSeek(经本地服务器 /api/llm 代理,密钥只在服务端) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function llm(cfg, prompt) {
  const body = {
    model: cfg.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "你只输出合法 JSON,不要输出任何其他文字。" },
      { role: "user", content: prompt },
    ],
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * 2 ** attempt); continue; }
    if (!res.ok) {
      let d = ""; try { const e = await res.json(); d = e.error?.message || e.error || ""; } catch {}
      throw new Error(`DeepSeek 请求失败 ${res.status}: ${d}`);
    }
    const j = await res.json();
    try {
      const r = JSON.parse(j.choices?.[0]?.message?.content || "");
      return Array.isArray(r) ? r : r.results || [];
    } catch { await sleep(500); } // 偶发非法 JSON,重试
  }
  throw new Error("DeepSeek 多次重试仍失败(可能被限流或输出异常),请稍后再试");
}

const cacheKey = (cfg, k) => `ai:${cfg.owner}/${cfg.repo}:${k}`;
function cacheGet(cfg, k) { try { return JSON.parse(localStorage.getItem(cacheKey(cfg, k))); } catch { return null; } }
function cacheSet(cfg, k, v) { try { localStorage.setItem(cacheKey(cfg, k), JSON.stringify(v)); } catch {} }

// 并发 worker 池
async function runPool(tasks, concurrency, onDone) {
  let i = 0, done = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      await t();
      onDone?.(++done, tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

async function classifyCommits(cfg, commits, progress) {
  const todo = [];
  for (const c of commits) {
    const hit = cacheGet(cfg, "c:" + c.sha);
    if (hit) c.ai = hit; else todo.push(c);
  }
  const batches = [];
  for (let i = 0; i < todo.length; i += 30) batches.push(todo.slice(i, i + 30));
  await runPool(batches.map((b) => async () => {
    const list = b.map((c, n) => `#${n}\n${clip(c.message, 500)}`).join("\n---\n");
    const prompt =
      "你是代码审查专家。判断下面每条 git commit message 是否 meaningful。\n" +
      "meaningful = 清楚说明了做了什么或为什么(如 \"fix null pointer in parser when input empty\")。\n" +
      "not meaningful = 空洞、无信息或随意(如 \"update\"、\"fix\"、\"asdf\"、\"wip\"、\"...\"、单个词且无上下文)。\n" +
      "id 用 #序号 对应(只返回数字序号字符串,如 \"0\")。reason 用中文,不超过 20 字。\n" +
      "只返回 JSON:{\"results\":[{\"id\":\"0\",\"meaningful\":true,\"reason\":\"...\"}]},每条 commit 一项。\n\n" + list;
    const res = await llm(cfg, prompt);
    for (const r of res) {
      const c = b[+String(r.id).replace("#", "")];
      if (!c) continue;
      c.ai = { meaningful: !!r.meaningful, reason: r.reason || "" };
      cacheSet(cfg, "c:" + c.sha, c.ai);
    }
  }), 2, (d, t) => progress(d, t));
}

async function classifyItems(cfg, items, progress) {
  const todo = [];
  for (const it of items) {
    const hit = cacheGet(cfg, `${it.id}:${it.updated}`);
    if (hit) it.ai = hit; else todo.push(it);
  }
  const batches = [];
  for (let i = 0; i < todo.length; i += 15) batches.push(todo.slice(i, i + 15));
  await runPool(batches.map((b) => async () => {
    const list = b.map((it, n) =>
      `#${n} [${it.kind === "p" ? "PR" : "ISSUE"}] 标题: ${it.title}\n标签: ${it.labels.join(", ") || "无"}\n正文: ${clip(it.body.replace(/\s+/g, " "), 700)}`
    ).join("\n---\n");
    const prompt =
      "判断下面每个 GitHub issue / PR 的类型。category 取值:\n" +
      "- bug_report: ISSUE 在报告一个 bug/缺陷/崩溃/错误行为\n" +
      "- bug_fix: PR 在修复一个 bug(含 fix/hotfix/修复崩溃/修正错误行为);纯功能新增、重构、文档、依赖升级不算\n" +
      "- feature: 新功能或增强\n- docs: 文档\n- chore: 构建/CI/依赖/重构/格式\n- question: 提问/讨论\n- other: 其他\n" +
      "注意:ISSUE 通常不应为 bug_fix,PR 通常不应为 bug_report。综合标题、标签、正文判断。\n" +
      "id 用 #序号 对应(只返回数字序号字符串)。reason 用中文,不超过 25 字。\n" +
      "只返回 JSON:{\"results\":[{\"id\":\"0\",\"category\":\"bug_fix\",\"reason\":\"...\"}]},每项一条,category 只能取上面列出的值。\n\n" + list;
    const res = await llm(cfg, prompt);
    for (const r of res) {
      const it = b[+String(r.id).replace("#", "")];
      if (!it) continue;
      it.ai = { category: r.category, reason: r.reason || "" };
      cacheSet(cfg, `${it.id}:${it.updated}`, it.ai);
    }
  }), 2, (d, t) => progress(d, t));
}

// ---------- 汇总 ----------
function buildAuthors(data) {
  const map = new Map();
  const get = (name) => {
    if (!map.has(name)) map.set(name, {
      name, commits: [], issues: [], prs: [], issueCmt: new Set(), prCmt: new Set(),
    });
    return map.get(name);
  };
  data.commits.forEach((c) => get(c.author).commits.push(c));
  data.issues.forEach((i) => get(i.author).issues.push(i));
  data.prs.forEach((p) => get(p.author).prs.push(p));
  data.comments.forEach((c) => (c.kind === "p" ? get(c.author).prCmt : get(c.author).issueCmt).add(c.number));
  for (const a of map.values()) {
    a.bugReports = a.issues.filter((i) => i.ai?.category === "bug_report");
    a.bugFixPRs = a.prs.filter((p) => p.ai?.category === "bug_fix");
    a.meaningful = a.commits.filter((c) => c.ai?.meaningful).length;
  }
  return [...map.values()].sort((x, y) => y.commits.length - x.commits.length || y.prs.length - x.prs.length);
}

// ---------- 渲染 ----------
let STATE = null;
let tab = "authors";

const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const yn = (v, yes = "是", no = "否") => `<span class="badge ${v ? "b-good" : "b-mute"}">${v ? yes : no}</span>`;
const CAT = {
  bug_report: ["Bug 报告", "b-bad"], bug_fix: ["Bug 修复", "b-good"], feature: ["功能", "b-mute"],
  docs: ["文档", "b-mute"], chore: ["杂项", "b-mute"], question: ["提问", "b-mute"], other: ["其他", "b-mute"],
};
const catBadge = (ai) => ai ? `<span class="badge ${CAT[ai.category]?.[1] || "b-mute"}">${esc(CAT[ai.category]?.[0] || ai.category)}</span>` : `<span class="badge b-mute">未判断</span>`;
const table = (head, rows) =>
  `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th${h.startsWith("#") ? ' class="num"' : ""}>${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

function selectedAuthor() { return $("authorFilter").value; }

function render() {
  if (!STATE) return;
  const { data, authors, ai } = STATE;
  const af = selectedAuthor();
  const byAuthor = (x) => !af || x.author === af;
  $("filterBar").hidden = tab === "authors";
  let html = "";

  if (tab === "authors") {
    html = `<p class="note">评论数 = 该作者留过评论的不同 issue / PR 数量(PR 含 review 行内评论)。${ai ? "" : "未启用 AI,相关列显示 -。"}</p>` +
      table(["作者", "#Commits", "#有意义 commit", "#Issues", "#Bug 报告", "#PRs", "#Bug-fix PR", "#评论过的 Issue", "#评论过的 PR", "有 Bug-fix PR"],
        authors.map((a) => `<tr><td>${link("https://github.com/" + a.name, a.name)}</td>
          <td class="num">${a.commits.length}</td><td class="num">${ai ? a.meaningful : "-"}</td>
          <td class="num">${a.issues.length}</td><td class="num">${ai ? a.bugReports.length : "-"}</td>
          <td class="num">${a.prs.length}</td><td class="num">${ai ? a.bugFixPRs.length : "-"}</td>
          <td class="num">${a.issueCmt.size}</td><td class="num">${a.prCmt.size}</td>
          <td>${ai ? yn(a.bugFixPRs.length > 0) : "-"}</td></tr>`));
  } else if (tab === "commits") {
    const list = data.commits.filter(byAuthor);
    html = table(["Commit", "作者", "日期", "信息", "#新增行", "#删除行", "是否 meaningful", "AI 理由"],
      list.map((c) => `<tr><td>${link(c.url, c.sha.slice(0, 7))}</td><td>${esc(c.author)}</td>
        <td>${esc(c.date.slice(0, 10))}</td><td class="msg">${esc(clip(c.message, 200))}</td>
        <td class="num" style="color:var(--good)">${c.stats ? "+" + c.stats.add : "-"}</td><td class="num" style="color:var(--bad)">${c.stats ? "−" + c.stats.del : "-"}</td>
        <td>${c.ai ? yn(c.ai.meaningful, "有意义", "无意义") : '<span class="badge b-mute">未判断</span>'}</td>
        <td class="reason">${esc(c.ai?.reason)}</td></tr>`));
  } else if (tab === "issues" || tab === "prs") {
    const src = tab === "issues" ? data.issues : data.prs;
    html = table(["#", "标题", "作者", "状态", "类型(AI)", "标签", "AI 理由"],
      src.filter(byAuthor).map((x) => `<tr><td>${link(x.url, "#" + x.number)}</td><td class="msg">${esc(x.title)}</td>
        <td>${esc(x.author)}</td><td>${x.merged ? "merged" : esc(x.state)}</td><td>${catBadge(x.ai)}</td>
        <td class="reason">${esc(x.labels.join(", "))}</td><td class="reason">${esc(x.ai?.reason)}</td></tr>`));
  } else if (tab === "comments") {
    const rows = authors.filter((a) => !af || a.name === af).map((a) => {
      const fmt = (set, kind) => [...set].sort((p, q) => q - p).slice(0, 30)
        .map((n) => link(`https://github.com/${STATE.cfg.owner}/${STATE.cfg.repo}/${kind}/${n}`, "#" + n)).join(" ");
      return `<tr><td>${esc(a.name)}</td><td class="num">${a.issueCmt.size}</td><td>${fmt(a.issueCmt, "issues")}</td>
        <td class="num">${a.prCmt.size}</td><td>${fmt(a.prCmt, "pull")}</td></tr>`;
    });
    html = `<p class="note">每人最多列出最近 30 个。</p>` + table(["作者", "#评论过的 Issue 数", "Issue", "#评论过的 PR 数", "PR"], rows);
  } else if (tab === "bugfix") {
    if (!ai) html = `<p class="note">需要启用 DeepSeek 才能判断 Bug-fix PR。</p>`;
    else html = `<p class="note">由 DeepSeek 根据 PR 标题、标签、正文判断。</p>` + table(["作者", "有 Bug-fix PR", "#数量", "#已 merge", "PR 列表"],
      authors.filter((a) => !af || a.name === af).map((a) =>
        `<tr><td>${esc(a.name)}</td><td>${yn(a.bugFixPRs.length > 0)}</td><td class="num">${a.bugFixPRs.length}</td>
        <td class="num">${a.bugFixPRs.filter((p) => p.merged).length}</td>
        <td>${a.bugFixPRs.map((p) => `<div>${link(p.url, "#" + p.number)} ${esc(clip(p.title, 80))} ${p.merged ? '<span class="badge b-good">merged</span>' : ""}<div class="reason">${esc(p.ai?.reason)}</div></div>`).join("") || "-"}</td></tr>`));
  }
  $("view").innerHTML = html;
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
});
$("authorFilter").onchange = render;

// ---------- 主流程 ----------
$("go").onclick = async () => {
  showError("");
  const btn = $("go");
  try {
    const { owner, repo } = parseRepo($("repo").value);
    const cfg = {
      owner, repo,
      token: $("ghToken").value.trim(),
      model: $("model").value.trim() || "deepseek-chat",
      maxCommits: Math.max(1, +$("maxCommits").value || 300),
      maxItems: Math.max(1, +$("maxItems").value || 300),
      maxCommentPages: Math.max(1, +$("maxCommentPages").value || 20),
    };
    const ai = $("useAI").checked;
    if (!cfg.token) throw new Error("请先粘贴 GitHub token");
    if (ai && !HAS_LLM) throw new Error("config.json 里没有 deepseek_api_key,请填写后重启 ./start.sh,或在高级设置里关闭 AI 判断");

    btn.disabled = true;
    $("report").hidden = true;
    const data = await fetchRepoData(cfg);

    if (ai) {
      const prog = (label, lo, hi) => (d, t) => setStatus(`DeepSeek 分析${label}… ${d}/${t} 批`, lo + ((hi - lo) * d) / Math.max(t, 1));
      setStatus("DeepSeek 分析 commits…", 40);
      await classifyCommits(cfg, data.commits, prog("commits", 40, 65));
      setStatus("DeepSeek 分析 issues…", 65);
      await classifyItems(cfg, data.issues, prog("issues", 65, 82));
      setStatus("DeepSeek 分析 PRs…", 82);
      await classifyItems(cfg, data.prs, prog("PRs", 82, 100));
    }

    const authors = buildAuthors(data);
    STATE = { cfg, data, authors, ai };
    $("authorFilter").innerHTML = `<option value="">全部作者</option>` + authors.map((a) => `<option>${esc(a.name)}</option>`).join("");
    $("repoTitle").textContent = `${owner}/${repo}  ·  ${data.commits.length} commits · ${data.issues.length} issues · ${data.prs.length} PRs`;
    $("report").hidden = false;
    setStatus("完成", 100);
    render();
  } catch (e) {
    showError(e.message || String(e));
    setStatus("");
  } finally {
    btn.disabled = false;
  }
};
