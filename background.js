// background.js - 负责与 popup、content script 通信并管理任务状态

const DEFAULT_SETTINGS = {
  strategyName: "",
  timeframe: "D",
  backtestFrom: "", // 例如 "2020-01-01"
  backtestTo: "",   // 留空表示到当前
  maxSymbols: 50,
  delayBetweenSymbolsMs: 8000 // 根据你本地网络与 TradingView 反应调整
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ tvBatchBacktestSettings: DEFAULT_SETTINGS });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_SETTINGS") {
    chrome.storage.sync.get("tvBatchBacktestSettings", (data) => {
      sendResponse(data.tvBatchBacktestSettings || DEFAULT_SETTINGS);
    });
    return true;
  }

  if (message?.type === "SAVE_SETTINGS") {
    chrome.storage.sync.set({ tvBatchBacktestSettings: message.payload }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "EXPORT_CSV") {
    const { rows, filename } = message.payload || {};
    const csvContent = rows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download(
      {
        url,
        filename: filename || "tradingview_backtest.csv",
        saveAs: true
      },
      () => {
        URL.revokeObjectURL(url);
      }
    );
    sendResponse({ ok: true });
    return true;
  }
});


