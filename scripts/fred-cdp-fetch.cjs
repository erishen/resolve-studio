// FRED 联邦基金利率抓取（走 CDP 浏览器的 TLS 指纹，绕过 Akamai 对 curl/urllib 的指纹拦截）。
// 浏览器指纹能过、脚本指纹不能——见 asset-lens market_fetcher 的 FED_FETCH_CMD 兜底说明。
//
// 输出：stdout 末行一个 JSON 对象 {"value":3.88,"date":"2026-10-28"}
// 用法：NODE_PATH=<...>/node_modules node fred-cdp-fetch.cjs
//   CDP 地址取 $CDP_URL（容器默认 http://browser-desk:9223）。
// 取 FRED 序列 FF（联邦基金目标利率）最后一个可解析观测值；解析失败 → 退出码 2。
const { chromium } = require("playwright-core");

(async () => {
  const cdp = process.env.CDP_URL || "http://browser-desk:9223";
  const browser = await chromium.connectOverCDP(cdp, { timeout: 20000 });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  try {
    const url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=FF&cosd=2025-01-01";
    const resp = await ctx.request.get(url, {
      timeout: 40000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const body = await resp.text();
    // 序列观测行形如 "2026-10-28,3.88"；取最后一个非缺失值（缺失用 "." 表示）。
    const obs = body
      .trim()
      .split("\n")
      .filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l));
    let val = null;
    let date = "";
    for (const l of obs) {
      const [d, v] = l.split(",");
      if (v && v !== "." && !Number.isNaN(parseFloat(v))) {
        val = parseFloat(v);
        date = d;
      }
    }
    if (val == null) {
      console.error("FRED: no valid FF observation parsed");
      process.exit(2);
    }
    // 末行必须是可被 json.loads 的单行对象（market_fetcher 约定读 stdout 最后一行）。
    console.log(JSON.stringify({ value: val, date }));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("FRED CDP fetch failed: " + e.message);
  process.exit(1);
});
