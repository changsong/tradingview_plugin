// content.js - 在 TradingView 页面内运行，负责：
// 1. 从筛选器中读取标的列表
// 2. 依次打开每个标的的图表并应用策略、时间周期与回测时间范围
// 3. 读取回测报告中的关键指标
// 4. 将结果通过 background 导出为 CSV

let isRunningBatch = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTextContent(el) {
  return (el?.innerText || "").trim();
}

function findElementsByText(root, matcher) {
  const nodes = Array.from(root.querySelectorAll("div, span, button, a, li, td"));
  return nodes.filter((el) => {
    const text = getTextContent(el);
    return text && matcher(text);
  });
}

function findFirstByText(root, matcher) {
  const nodes = findElementsByText(root, matcher);
  return nodes.length ? nodes[0] : null;
}

function findClosestListContainer(titleEl) {
  if (!titleEl) return null;
  let current = titleEl;
  for (let i = 0; i < 6; i++) {
    current = current.parentElement;
    if (!current) break;
    const hasListRole = current.getAttribute("role") === "list" || current.getAttribute("role") === "listbox";
    const listItems = current.querySelectorAll("li, [role='listitem'], [data-symbol]");
    if (hasListRole || listItems.length >= 3) {
      return current;
    }
  }
  return titleEl.closest("section, div");
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
      resolve(settings || {});
    });
  });
}

function detectWatchlistRows(listName, maxSymbols) {
  const widget = document.querySelector('[data-test-id-widget-type="watchlist"]');
  if (!widget) return [];

  const headerTitle = widget.querySelector(
    '[data-name="watchlists-button"] .titleRow-mQBvegEO, [data-name="watchlists-button"] span'
  );
  const titleText = getTextContent(headerTitle);
  if (listName && titleText && titleText !== listName) {
    return [];
  }

  const listRoot =
    widget.querySelector('[data-name="symbol-list-wrap"]') || widget.querySelector('[data-name="tree"]') || widget;

  const items = Array.from(
    listRoot.querySelectorAll("[data-symbol-full], [data-symbol-short]")
  );
  return items.slice(0, maxSymbols);
}

function clickWatchlistRow(row) {
  if (!row) return false;
  const clickable =
    row.querySelector(".symbol-RsFlttSS") ||
    row.closest(".wrap-IEe5qpW4") ||
    row;
  const target = clickable instanceof HTMLElement ? clickable : row;
  const symbolText = target.querySelector(".symbolNameText-RsFlttSS");

  const fireClick = (el) => {
    if (!el) return;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };

  target.scrollIntoView({ block: "center" });
  if (symbolText) {
    fireClick(symbolText);
  }
  fireClick(target);
  return true;
}

function detectScreenerRows(maxSymbols) {
  // 这里假设你在 TradingView「筛选器」页面，主表格里每一行代表一个标的。
  // TradingView HTML 经常变化，因此选择器可能需要你自己稍后微调。
  const table = document.querySelector("table");
  if (!table) return [];

  const rows = Array.from(table.querySelectorAll("tbody tr"));
  return rows.slice(0, maxSymbols);
}

function extractSymbolFromRow(row) {
  // 典型情况：第一列包含代码，例如 "AAPL" / "600519"
  const dataSymbol =
    row.getAttribute("data-symbol") ||
    row.getAttribute("data-symbol-id") ||
    row.getAttribute("data-symbol-short") ||
    row.getAttribute("data-symbol-full");
  if (dataSymbol) {
    const trimmed = dataSymbol.trim();
    if (trimmed.includes(":")) {
      return trimmed.split(":").pop();
    }
    return trimmed;
  }
  const firstCell = row.querySelector("td");
  if (!firstCell) return null;
  const text = firstCell.innerText.trim();
  return text || null;
}

async function openSymbolInChart(symbol) {
  // TradingView 提供快捷键和页面交互方式，但 DOM 结构经常变化。
  // 这里采用最通用的方式：直接修改 URL 打开图表。
  // 假设当前页面在 `https://www.tradingview.com/screener/`，我们跳转到图表 URL。
  const base = location.origin;
  const chartUrl = `${base}/chart/?symbol=${encodeURIComponent(symbol)}`;
  window.open(chartUrl, "_blank");
}

function findStrategyItem(strategyName) {
  // 在图表页面右侧“策略测试器 / 指标与策略”中找到目标策略。
  // 由于 TradingView 的 DOM 结构经常更新，这里只写大致思路，你需要打开开发者工具检查实际 className。
  const panels = document.querySelectorAll("div, button, span");
  const lower = strategyName.toLowerCase();
  for (const el of panels) {
    const text = el.innerText && el.innerText.trim().toLowerCase();
    if (text && text === lower) {
      return el;
    }
  }
  return null;
}

async function waitForOutdatedReportAndUpdate(appearTimeoutMs = 30000, postClickWaitMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < appearTimeoutMs) {
    const snackbar = document.querySelector('[data-qa-id="backtesting-updated-report-snackbar"]');
    const updateBtn =
      snackbar?.querySelector("button.snackbarButton-GBq6Mkel") ||
      findFirstByText(document, (text) => text.includes("更新报告"));
    if (updateBtn) {
      updateBtn.click();
      await sleep(postClickWaitMs);
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function openStrategyReportMetricsTab() {
  const reportTab = findFirstByText(document, (text) => text.includes("策略报告") || text.includes("策略测试"));
  if (reportTab) {
    reportTab.click();
    await sleep(500);
  }

  const metricsTab = findFirstByText(document, (text) => text.trim() === "指标");
  if (metricsTab) {
    metricsTab.click();
    await sleep(500);
  }
}

async function applyStrategyAndTimeframeInChart(settings) {
  const { strategyName, timeframe } = settings;

  // 1. 设置时间周期：TradingView 图表左上角的周期按钮，可通过快捷键或 DOM 点击。
  // 最稳的是使用键盘：先聚焦图表，再发送数字/字母组合，但 content script 无法模拟键盘事件到 TradingView 内部逻辑，
  // 因此这里使用简单 DOM 点击 + 选择文本方式作为示例（实际项目需要你根据当前 DOM 结构手工微调）。

  // 打开时间框下拉
  const tfButton = document.querySelector('[data-name="timeframes-toolbar"] button, [data-name="timeframe"]');
  if (tfButton) {
    tfButton.click();
    await sleep(300);
    const items = Array.from(document.querySelectorAll("div, span, button"));
    const target = items.find((el) => el.innerText && el.innerText.trim() === timeframe);
    if (target) target.click();
  }

  // 2. 应用策略：打开 "指标与策略" 面板并选择策略
  if (strategyName) {
    const indicatorsBtn = document.querySelector('[data-name="indicator-button"], [data-name="indicators"]');
    if (indicatorsBtn) {
      indicatorsBtn.click();
      await sleep(500);
    }

    const strategyItem = findStrategyItem(strategyName);
    if (strategyItem) {
      strategyItem.click();
    } else {
      console.warn("未在页面中找到策略：", strategyName);
    }
  }
}

async function configureBacktestRange(settings) {
  const { backtestFrom, backtestTo } = settings;
  if (!backtestFrom && !backtestTo) return;

  // 打开“策略测试器”，查找日期输入框进行设置。
  // 由于 DOM 经常变化，这里同样只给出逻辑骨架：
  const testerTab = Array.from(document.querySelectorAll("button, div, span")).find(
    (el) => el.innerText && el.innerText.trim().includes("策略测试")
  );
  if (testerTab) {
    testerTab.click();
    await sleep(500);
  }

  // 实际要用开发者工具找到 Backtesting 日期区间控件的 input 或按钮
  // 这里只用占位选择器：
  const fromInput = document.querySelector("input[data-role='backtest-from'], input[placeholder*='From']");
  const toInput = document.querySelector("input[data-role='backtest-to'], input[placeholder*='To']");

  if (fromInput && backtestFrom) {
    fromInput.value = "";
    fromInput.dispatchEvent(new Event("input", { bubbles: true }));
    fromInput.value = backtestFrom;
    fromInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  if (toInput && backtestTo) {
    toInput.value = "";
    toInput.dispatchEvent(new Event("input", { bubbles: true }));
    toInput.value = backtestTo;
    toInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // 如果有“应用/确定”按钮，记得点击
  const applyBtn = Array.from(document.querySelectorAll("button")).find(
    (el) => el.innerText && /应用|确定|Apply/i.test(el.innerText)
  );
  if (applyBtn) {
    applyBtn.click();
  }
}

function readBacktestResultForCurrentSymbol(symbol) {
  // 在“策略报告-指标”面板中读取关键指标。
  // 需要你根据当前 TradingView 的 DOM 结构定制选择器，这里给出通用骨架。

  const result = {
    symbol,
    totalPnL: "",
    maxEquityDrawdown: "",
    totalTrades: "",
    winningTradesPercent: "",
    profitFactor: ""
  };

  const root = document;
  const textNodes = Array.from(root.querySelectorAll("div, span, td"));

  function findByLabel(labelKeywords) {
    const lowerKeywords = labelKeywords.map((k) => k.toLowerCase());
    for (let i = 0; i < textNodes.length; i++) {
      const el = textNodes[i];
      const text = (el.innerText || "").trim().toLowerCase();
      if (!text) continue;
      if (lowerKeywords.some((k) => text.includes(k))) {
        // 尝试在下一个节点里取数值
        const next = textNodes[i + 1];
        if (next && next.innerText) {
          return next.innerText.trim();
        }
      }
    }
    return "";
  }

  result.totalPnL = findByLabel(["总盈亏", "Total P&L", "Total P/L", "净利润", "Net profit"]);
  result.maxEquityDrawdown = findByLabel(["最大股权回撤", "Max equity drawdown", "最大回撤", "Max drawdown"]);
  result.totalTrades = findByLabel(["总交易数", "Total trades", "交易次数", "Total closed trades"]);
  result.winningTradesPercent = findByLabel(["盈利交易占比", "Winning trades", "Win rate"]);
  result.profitFactor = findByLabel(["盈利因子", "Profit factor"]);

  return result;
}

async function runBatchOnScreenerPage() {
  if (isRunningBatch) return;
  isRunningBatch = true;

  const settings = await getSettings();
  const maxSymbols = settings.maxSymbols || 50;
  let rows = detectWatchlistRows("A股可交易", maxSymbols);
  let source = "watchlist";
  if (!rows.length) {
    rows = detectScreenerRows(maxSymbols);
    source = "screener";
  }
  if (!rows.length) {
    alert("未在当前页面找到 A股可交易 监视列表或筛选器表格。");
    isRunningBatch = false;
    return;
  }

  const symbols = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const symbol = extractSymbolFromRow(row) || getTextContent(row).split(/\s+/)[0];
    if (symbol) symbols.push(symbol);
  }

  if (!symbols.length) {
    alert("未从筛选器中解析到任何标的代码。");
    isRunningBatch = false;
    return;
  }

  const { delayBetweenSymbolsMs = 8000 } = settings;
  const csvRows = [];
  csvRows.push("symbol,totalPnL,maxEquityDrawdown,totalTrades,winningTradesPercent,profitFactor");

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    console.log(`开始处理第 ${i + 1}/${symbols.length} 个标的: ${symbol}`);

    if (source === "watchlist") {
      const currentRows = detectWatchlistRows("A股可交易", maxSymbols);
      const targetRow = currentRows[i];
      if (targetRow) {
        clickWatchlistRow(targetRow);
      }
    } else {
      // 简化实现：直接在当前 tab 中切换 symbol，避免频繁开新 tab（更稳定）
      // TradingView 支持在图表上方的代码输入框切换标的，通过 DOM 操作该输入框：
      const symbolInput = document.querySelector("input[data-name='header-symbol-search'], input[placeholder*='Symbol']");
      if (symbolInput) {
        symbolInput.focus();
        symbolInput.value = "";
        symbolInput.dispatchEvent(new Event("input", { bubbles: true }));
        symbolInput.value = symbol;
        symbolInput.dispatchEvent(new Event("input", { bubbles: true }));
        symbolInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      } else {
        // 如果当前不是图表页，而是筛选器页，可以尝试点击行打开图表
        rows[i].click();
      }
    }

    // 等待图表与数据加载
    await sleep(delayBetweenSymbolsMs);

    await applyStrategyAndTimeframeInChart(settings);
    await configureBacktestRange(settings);
    await openStrategyReportMetricsTab();
    await waitForOutdatedReportAndUpdate(5000);

    // 再等一会儿，确保回测结果刷新完成
    await sleep(3000);

    const result = readBacktestResultForCurrentSymbol(symbol);
    const row = [
      result.symbol,
      JSON.stringify(result.totalPnL || ""),
      JSON.stringify(result.maxEquityDrawdown || ""),
      JSON.stringify(result.totalTrades || ""),
      JSON.stringify(result.winningTradesPercent || ""),
      JSON.stringify(result.profitFactor || "")
    ].join(",");
    csvRows.push(row);
  }

  chrome.runtime.sendMessage(
    {
      type: "EXPORT_CSV",
      payload: {
        rows: csvRows,
        filename: `tradingview_backtest_${new Date().toISOString().slice(0, 10)}.csv`
      }
    },
    () => {
      alert("批量回测完成，CSV 已开始下载。");
      isRunningBatch = false;
    }
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TV_START_BATCH") {
    runBatchOnScreenerPage().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});


