// popup.js - 负责展示和保存配置，并触发在当前 TradingView 页的批量回测

const strategyNameInput = document.getElementById("strategyName");
const submitUrlInput = document.getElementById("submitUrl");
const maxSymbolsInput = document.getElementById("maxSymbols");
const delayInput = document.getElementById("delayBetweenSymbolsMs");
const saveBtn = document.getElementById("saveBtn");
const startBtn = document.getElementById("startBtn");

function loadSettings() {
  chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
    if (!settings) return;
    strategyNameInput.value = settings.strategyName || "";
    submitUrlInput.value =
      settings.submitUrl || "https://www.zsihuo.com/backtest";
    maxSymbolsInput.value = settings.maxSymbols || 50;
    delayInput.value = settings.delayBetweenSymbolsMs || 8000;
  });
}

function saveSettings() {
  const payload = {
    strategyName: strategyNameInput.value.trim(),
    submitUrl:
      submitUrlInput.value.trim() || "https://www.zsihuo.com/backtest",
    maxSymbols: Number(maxSymbolsInput.value) || 50,
    delayBetweenSymbolsMs: Number(delayInput.value) || 8000
  };

  chrome.runtime.sendMessage(
    { type: "SAVE_SETTINGS", payload },
    () => {
      saveBtn.textContent = "已保存";
      setTimeout(() => {
        saveBtn.textContent = "保存设置";
      }, 1000);
    }
  );
}

async function startBatchOnCurrentTab() {
  startBtn.disabled = true;
  startBtn.textContent = "正在启动...";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab || !tab.id) {
      alert("未找到当前标签页。请在 TradingView 筛选器页面中使用。");
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });

    chrome.tabs.sendMessage(tab.id, { type: "TV_START_BATCH" }, (resp) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        alert("无法在当前页面注入脚本，请确认是 TradingView 页面。");
      } else if (resp?.ok) {
        window.close();
      }
    });
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "在当前 TradingView 标签页开始批量回测";
  }
}

saveBtn.addEventListener("click", saveSettings);
startBtn.addEventListener("click", () => {
  saveSettings();
  startBatchOnCurrentTab();
});

document.addEventListener("DOMContentLoaded", loadSettings);


