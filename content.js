// content.js - 在 TradingView 页面内运行，负责：
// 1. 从筛选器中读取标的列表
// 2. 依次打开每个标的的图表并应用策略、时间周期与回测时间范围
// 3. 读取回测报告中的关键指标
// 4. 将结果通过 background 导出为 CSV

(() => {
  if (globalThis.__tvBatchInjected) {
    return;
  }
  globalThis.__tvBatchInjected = true;

let isRunningBatch = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTextContent(el) {
  return (el?.innerText || "").trim();
}

function logWithTime(...args) {
  const now = new Date();
  const tzOffsetMs = 8 * 60 * 60 * 1000;
  const bj = new Date(now.getTime() + tzOffsetMs);
  const pad = (num) => String(num).padStart(2, "0");
  const ts = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(
    bj.getUTCDate()
  )} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(
    bj.getUTCSeconds()
  )}`;
  console.log(`[${ts}]`, ...args);
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
    widget.querySelector(".listContainer-MgF6KBas") ||
    widget.querySelector('[data-name="tree"]') ||
    widget.querySelector('[data-name="symbol-list-wrap"]') ||
    widget;

  const items = Array.from(
    listRoot.querySelectorAll(".symbol-RsFlttSS[data-symbol-full], .symbol-RsFlttSS[data-symbol-short]")
  );
  return items.slice(0, maxSymbols);
}

function getWatchlistListContainer() {
  const widget = document.querySelector('[data-test-id-widget-type="watchlist"]');
  return (
    widget?.querySelector(".listContainer-MgF6KBas") ||
    widget?.querySelector('[data-name="tree"]') ||
    widget?.querySelector('[data-name="symbol-list-wrap"]') ||
    null
  );
}

function fireKey(el, key) {
  if (!el) return;
  const eventInit = { bubbles: true, key, code: key, view: window };
  el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}


function isWatchlistRowSelected(row) {
  if (!row) return false;
  const ariaSelected = row.getAttribute("aria-selected") === "true";
  const ariaChecked = row.getAttribute("aria-checked") === "true";
  const dataActive = row.getAttribute("data-active") === "true";
  const dataSelected = row.getAttribute("data-selected") === "true";
  const dataState = /active|selected|current/i.test(row.getAttribute("data-state") || "");
  const className = row.className || "";
  const classSelected = /isActive|active|selected|current/i.test(className);
  const selectedParent = row.closest(
    ".isActive, .active, .selected, .current, [data-active='true'], [data-selected='true'], [aria-selected='true']"
  );
  return (
    ariaSelected ||
    ariaChecked ||
    dataActive ||
    dataSelected ||
    dataState ||
    classSelected ||
    !!selectedParent
  );
}

function logWatchlistRowState(symbol, row) {
  if (!row) {
    logWithTime(`${symbol} 行不存在，无法选中`);
    return;
  }
  const attrs = {
    ariaSelected: row.getAttribute("aria-selected"),
    ariaChecked: row.getAttribute("aria-checked"),
    dataActive: row.getAttribute("data-active"),
    dataSelected: row.getAttribute("data-selected"),
    dataState: row.getAttribute("data-state"),
    className: row.className
  };
  logWithTime(`${symbol} 行状态`, attrs);
}

async function ensureWatchlistSelected(symbol, rowHint, index) {
  const listContainer = getWatchlistListContainer();
  if (!listContainer) return false;
  let row = rowHint || getWatchlistRowBySymbol(listContainer, symbol);
  if (!row) {
    row = await scrollFindWatchlistRow(listContainer, symbol);
  }
  if (!row) {
    listContainer.focus();
    await sleep(50);
    return false;
  }
  row.scrollIntoView({ block: "center" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    clickWatchlistRow(row);
    await sleep(120);
    listContainer.focus();
    await sleep(60);
    if (isWatchlistRowSelected(row)) {
      logWithTime(`${symbol} 行已选中(尝试${attempt})`);
      return true;
    }
    logWithTime(`${symbol} 行未选中(尝试${attempt})`);
  }
  if (Number.isFinite(index)) {
    const scrolled = await selectWatchlistByScrollAndClick(listContainer, symbol);
    if (scrolled) {
      await sleep(120);
      if (isWatchlistRowSelected(row)) {
        logWithTime(`${symbol} 行已选中(滚动点击)`);
        return true;
      }
    }
  }
  listContainer.focus();
  fireKey(listContainer, "Enter");
  await sleep(80);
  logWatchlistRowState(symbol, row);
  return isWatchlistRowSelected(row);
}

async function selectWatchlistByKeyboard(listContainer, index) {
  if (!listContainer) return false;
  listContainer.focus();
  await sleep(50);
  if (index === 0) {
    fireKey(listContainer, "Home");
    await sleep(50);
  } else {
    fireKey(listContainer, "ArrowDown");
    await sleep(50);
  }
  fireKey(listContainer, "Enter");
  return true;
}

function getWatchlistRowBySymbol(listContainer, symbol) {
  if (!listContainer || !symbol) return null;
  return (
    listContainer.querySelector(`.symbol-RsFlttSS[data-symbol-short="${symbol}"]`) ||
    listContainer.querySelector(`.symbol-RsFlttSS[data-symbol-full$=":${symbol}"]`)
  );
}

async function scrollFindWatchlistRow(listContainer, symbol) {
  if (!listContainer || !symbol) return null;
  const firstRow = listContainer.querySelector(".symbol-RsFlttSS");
  const rowHeight = firstRow?.getBoundingClientRect().height || 30;
  const step = Math.max(rowHeight * 10, 150);
  const maxScrollTop = listContainer.scrollHeight;
  for (let scrollTop = 0; scrollTop <= maxScrollTop; scrollTop += step) {
    listContainer.scrollTop = scrollTop;
    await sleep(120);
    const row = getWatchlistRowBySymbol(listContainer, symbol);
    if (row) {
      return row;
    }
  }
  return null;
}

async function selectWatchlistByScrollAndClick(listContainer, symbol) {
  if (!listContainer) return false;
  const row = (await scrollFindWatchlistRow(listContainer, symbol)) ||
    listContainer.querySelector(".symbol-RsFlttSS");
  if (row) {
    return clickWatchlistRow(row);
  }
  return false;
}

async function collectWatchlistSymbols(maxSymbols) {
  const listContainer = getWatchlistListContainer();
  if (!listContainer) return [];

  const firstRow = listContainer.querySelector(".symbol-RsFlttSS");
  const rowHeight = firstRow?.getBoundingClientRect().height || 30;
  const step = Math.max(rowHeight * 10, 150);
  const seen = new Set();
  let unchangedRounds = 0;
  let lastSeenSize = 0;

  for (let scrollTop = 0; scrollTop <= listContainer.scrollHeight; scrollTop += step) {
    listContainer.scrollTop = scrollTop;
    await sleep(120);
    const rows = Array.from(
      listContainer.querySelectorAll(".symbol-RsFlttSS[data-symbol-short], .symbol-RsFlttSS[data-symbol-full]")
    );
    for (const row of rows) {
      const symbol = extractSymbolFromRow(row);
      if (symbol) {
        seen.add(symbol);
        if (seen.size >= maxSymbols) {
          return Array.from(seen);
        }
      }
    }

    if (seen.size === 0) continue;
    if (seen.size === lastSeenSize) {
      unchangedRounds += 1;
    } else {
      unchangedRounds = 0;
    }
    lastSeenSize = seen.size;

    if (unchangedRounds >= 3) {
      break;
    }
  }

  return Array.from(seen);
}

function clickWatchlistRow(row) {
  if (!row) return false;
  const wrap = row.closest(".wrap-IEe5qpW4");
  const symbolRow = row.classList.contains("symbol-RsFlttSS")
    ? row
    : row.querySelector(".symbol-RsFlttSS");
  const target = wrap || symbolRow || row;
  const symbolText = target.querySelector?.(".symbolNameText-RsFlttSS");

  const fireClickAt = (el) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const common = {
      bubbles: true,
      composed: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      view: window,
      button: 0,
      buttons: 1,
      detail: 1
    };
    const pointer = {
      ...common,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      pressure: 0.5
    };
    el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    el.dispatchEvent(new MouseEvent("mousedown", common));
    el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", common));
    el.dispatchEvent(new PointerEvent("click", { ...pointer, buttons: 0, pressure: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
  };

  target.scrollIntoView({ block: "center" });
  if (symbolText) {
    fireClickAt(symbolText);
  }
  fireClickAt(target);
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

function setSymbolViaHeaderInput(symbol) {
  const symbolInput = document.querySelector(
    "input[data-name='header-symbol-search'], input[placeholder*='Symbol']"
  );
  if (!symbolInput) return false;
  symbolInput.focus();
  symbolInput.value = "";
  symbolInput.dispatchEvent(new Event("input", { bubbles: true }));
  symbolInput.value = symbol;
  symbolInput.dispatchEvent(new Event("input", { bubbles: true }));
  symbolInput.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
  );
  return true;
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

async function waitForOutdatedReportAndUpdate(appearTimeoutMs = 30000, postClickWaitMs = 10000) {
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
    await sleep(200);
  }

  const metricsTab = findFirstByText(document, (text) => text.trim() === "指标");
  if (metricsTab) {
    metricsTab.click();
    await sleep(200);
  }
}

async function applyStrategyAndTimeframeInChart(settings) {
  const { strategyName, timeframe } = settings;

  // 1. 设置时间周期：TradingView 图表左上角的周期按钮，可通过快捷键或 DOM 点击。
  // 最稳的是使用键盘：先聚焦图表，再发送数字/字母组合，但 content script 无法模拟键盘事件到 TradingView 内部逻辑，
  // 因此这里使用简单 DOM 点击 + 选择文本方式作为示例（实际项目需要你根据当前 DOM 结构手工微调）。

  if (timeframe) {
  // 打开时间框下拉
    const tfButton = document.querySelector(
      '[data-name="timeframes-toolbar"] button, [data-name="timeframe"]'
    );
  if (tfButton) {
    tfButton.click();
      await sleep(200);
    const items = Array.from(document.querySelectorAll("div, span, button"));
      const target = items.find(
        (el) => el.innerText && el.innerText.trim() === timeframe
      );
    if (target) target.click();
    }
  }

  // 2. 应用策略：打开 "指标与策略" 面板并选择策略
  if (strategyName) {
    const indicatorsBtn = document.querySelector('[data-name="indicator-button"], [data-name="indicators"]');
    if (indicatorsBtn) {
      indicatorsBtn.click();
      await sleep(300);
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
    await sleep(300);
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
    profitFactor: "",
    sharpeRatio: ""
  };

  const normalize = (text) =>
    (text || "")
      .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  function readStrategyName() {
    const button = document.querySelector("[data-strategy-title]");
    const title = normalize(button?.getAttribute("data-strategy-title") || "");
    if (title) return title;
    const fallback = document.querySelector(
      ".strategyGroup-rQLA_iPz [role='button'], [data-name='strategy-group'] [role='button']"
    );
    return normalize(fallback?.innerText);
  }

  function readMetricCard(titleText) {
    const titles = Array.from(document.querySelectorAll(".title-nEWm7_ye"));
    const titleEl = titles.find((el) => normalize(el.innerText) === titleText);
    if (!titleEl) return { value: "", percent: "" };
    const cell = titleEl.closest(".containerCell-zres18Ue");
    if (!cell) return { value: "", percent: "" };
    const valueEl = cell.querySelector(".highlightedValue-DiHajR6I, .value-DiHajR6I");
    const percentEl = cell.querySelector(".change-DiHajR6I");
    return {
      value: normalize(valueEl?.innerText),
      percent: normalize(percentEl?.innerText)
    };
  }

  function readTableValue(titleText, scope) {
    const root = scope || document;
    const titleCells = Array.from(root.querySelectorAll(".title-fArEbVva"));
    const titleEl = titleCells.find((el) =>
      normalize(el.innerText).includes(titleText)
    );
    let row = titleEl?.closest("tr");
    if (!row) {
      const rows = Array.from(root.querySelectorAll("tr"));
      row = rows.find((tr) => normalize(tr.innerText).includes(titleText));
    }
    if (!row) return "";
    const valueEls = Array.from(row.querySelectorAll(".value-SLMKagwH"));
    const valueEl =
      valueEls.find((el) => normalize(el.innerText)) || valueEls[0];
    return normalize(valueEl?.innerText);
        }

  const totalPnL = readMetricCard("总盈亏");
  const maxDrawdown = readMetricCard("最大股权回撤");
  const totalTrades = readMetricCard("总交易");
  const winningTrades = readMetricCard("盈利交易");
  const profitFactor = readMetricCard("盈利因子");

  result.strategyName = readStrategyName();
  result.totalPnL = totalPnL.percent || totalPnL.value;
  result.maxEquityDrawdown = maxDrawdown.percent || maxDrawdown.value;
  result.totalTrades = totalTrades.value;
  result.winningTradesPercent = winningTrades.value || winningTrades.percent;
  result.profitFactor = profitFactor.value;
  const ratiosTable = document.querySelector('[data-qa-id="ratios-table"]');
  result.sharpeRatio =
    readTableValue("夏普比率", ratiosTable) ||
    readTableValue("Sharpe Ratio", ratiosTable) ||
    readTableValue("夏普比率");

  return result;
}

async function runBatchOnScreenerPage() {
  if (isRunningBatch) return;
  isRunningBatch = true;

  const settings = await getSettings();
  const maxSymbols = settings.maxSymbols || 5000;
  const submitUrl = settings.submitUrl || "https://www.zsihuo.com/backtest";
  const watchlistNames = ["A股可交易", "美股可交易", "港股可交易"];
  const watchlistMarketMap = {
    A股可交易: "CN",
    美股可交易: "US",
    港股可交易: "HK"
  };
  let rows = detectWatchlistRows(watchlistNames[0], maxSymbols);
  let source = "watchlist";
  let watchlistName = watchlistNames[0];
  if (!rows.length) {
    rows = detectWatchlistRows(watchlistNames[1], maxSymbols);
    watchlistName = watchlistNames[1];
  }
  if (!rows.length) {
    rows = detectWatchlistRows(watchlistNames[2], maxSymbols);
    watchlistName = watchlistNames[2];
  }
  if (!rows.length) {
    rows = detectScreenerRows(maxSymbols);
    source = "screener";
  }
  if (!rows.length) {
    alert("未在当前页面找到 A股可交易 / 美股可交易 / 港股可交易 监视列表或筛选器表格。");
    isRunningBatch = false;
    return;
  }

  let symbols = [];
  if (source === "watchlist") {
    symbols = await collectWatchlistSymbols(maxSymbols);
  } else {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const symbol = extractSymbolFromRow(row) || getTextContent(row).split(/\s+/)[0];
    if (symbol) symbols.push(symbol);
    }
  }

  if (!symbols.length) {
    alert("未从筛选器中解析到任何标的代码。");
    isRunningBatch = false;
    return;
  }

  const { delayBetweenSymbolsMs = 5000 } = settings;
  const market = source === "watchlist" ? watchlistMarketMap[watchlistName] || "" : "";
  const results = [];
  const parsePercentValue = (value) => {
    if (!value) return NaN;
    const normalized = String(value)
      .replace(/[−–—]/g, "-")
      .replace(/[＋]/g, "+")
      .replace(/[％]/g, "%");
    const match = normalized.match(/[+-]?\d+(?:[.,]\d+)?/);
    if (!match) return NaN;
    return parseFloat(match[0].replace(/,/g, ""));
  };
  const parseNumberValue = (value) => {
    if (!value) return NaN;
    let normalized = String(value)
      .replace(/[−–—]/g, "-")
      .replace(/[＋]/g, "+")
      .replace(/\s+/g, "")
      .replace(/[％]/g, "%");
    if (normalized.includes(",") && !normalized.includes(".")) {
      normalized = normalized.replace(/,/g, ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
    const match = normalized.match(/[+-]?\d+(?:\.\d+)?/);
    if (!match) return NaN;
    return parseFloat(match[0]);
  };

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    logWithTime(`开始处理第 ${i + 1}/${symbols.length} 个标的: ${symbol}`);
    let targetRow = null;

    if (source === "watchlist") {
      const listContainer = getWatchlistListContainer();
      targetRow = listContainer
        ? getWatchlistRowBySymbol(listContainer, symbol)
        : null;
      if (!targetRow && listContainer) {
        targetRow = await scrollFindWatchlistRow(listContainer, symbol);
      }
      const inputSwitched = setSymbolViaHeaderInput(symbol);
      if (!inputSwitched) {
        const scrollClicked = await selectWatchlistByScrollAndClick(listContainer, symbol);
        if (!scrollClicked) {
          const keyboardOk = await selectWatchlistByKeyboard(listContainer, i);
          if (!keyboardOk && targetRow) {
            clickWatchlistRow(targetRow);
          }
        }
      }
    } else {
    // 简化实现：直接在当前 tab 中切换 symbol，避免频繁开新 tab（更稳定）
    // TradingView 支持在图表上方的代码输入框切换标的，通过 DOM 操作该输入框：
      if (!setSymbolViaHeaderInput(symbol)) {
      // 如果当前不是图表页，而是筛选器页，可以尝试点击行打开图表
      rows[i].click();
      }
    }

    // 等待图表与数据加载
    await sleep(delayBetweenSymbolsMs);

    await applyStrategyAndTimeframeInChart(settings);
    await configureBacktestRange(settings);
    await openStrategyReportMetricsTab();
    await waitForOutdatedReportAndUpdate(3000);

    // 再等一会儿，确保回测结果刷新完成
    await sleep(1500);

    const result = readBacktestResultForCurrentSymbol(symbol);
    const totalPnLPercent = parsePercentValue(result.totalPnL);
    const sharpeRatio = parseNumberValue(result.sharpeRatio);
    const hasSharpe = Number.isFinite(sharpeRatio);
    const minPnLPercent = Number.isFinite(Number(settings.minPnLPercent))
      ? Number(settings.minPnLPercent)
      : 13;
    const minSharpeRatio = Number.isFinite(Number(settings.minSharpeRatio))
      ? Number(settings.minSharpeRatio)
      : 1.2;
    const shouldDelete =
      (!Number.isNaN(totalPnLPercent) && totalPnLPercent < minPnLPercent) ||
      (hasSharpe && sharpeRatio < minSharpeRatio);
    if (shouldDelete) {
      if (source === "watchlist" && targetRow) {
        await ensureWatchlistSelected(result.symbol || symbol, targetRow, i);
        const deleteBtn = targetRow.querySelector(
          ".removeButton-RsFlttSS, .removeButton-Tf8QRdrk"
        );
        if (deleteBtn) {
          deleteBtn.click();
          logWithTime(`${symbol} 低于阈值，已点击删除`);
        } else {
          logWithTime(`${symbol} 低于阈值，但未找到删除按钮`);
  }
      } else {
        logWithTime(`${symbol} 低于阈值，已标记`);
      }
    }
    if (
      !Number.isNaN(totalPnLPercent) &&
      hasSharpe &&
      totalPnLPercent >= minPnLPercent &&
      sharpeRatio >= minSharpeRatio
    ) {
      results.push({
        symbol: result.symbol,
        market: market,
        strategyName: result.strategyName,
        totalPnL: result.totalPnL,
        maxEquityDrawdown: result.maxEquityDrawdown,
        totalTrades: result.totalTrades,
        winningTradesPercent: result.winningTradesPercent,
        profitFactor: result.profitFactor,
        sharpeRatio: result.sharpeRatio
      });
    }
    logWithTime(
      `${result.symbol} PnL=${result.totalPnL} Sharpe=${result.sharpeRatio} (parsedPnL=${totalPnLPercent} parsedSharpe=${hasSharpe ? sharpeRatio : "NaN"} thresholdPnL=${minPnLPercent} thresholdSharpe=${minSharpeRatio} match=${!Number.isNaN(totalPnLPercent) && hasSharpe && totalPnLPercent >= minPnLPercent && sharpeRatio >= minSharpeRatio} delete=${shouldDelete})`
    );
  }

  try {
    const payload = JSON.stringify(results);
    logWithTime("payload", payload);
    await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: payload
    });
    alert("批量回测完成，结果已提交。");
  } catch (error) {
    console.error(error);
    alert("批量回测完成，但提交失败，请查看控制台。");
  } finally {
      isRunningBatch = false;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TV_START_BATCH") {
    runBatchOnScreenerPage().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

})();
