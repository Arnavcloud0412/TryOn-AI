// Service worker: opens the side panel, provides the "Try this on" context menu
// and forwards tab changes so the panel can re-scan the current page.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: 'tryon-image',
    title: 'Try this on with TryOn AI',
    contexts: ['image'],
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'tryon-image' || !tab) return;
  // Must be called synchronously within the user gesture.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  await chrome.storage.session.set({
    pendingImage: { srcUrl: info.srcUrl, pageUrl: info.pageUrl || tab.url, tabId: tab.id, title: tab.title, at: Date.now() },
  });
  chrome.runtime.sendMessage({ type: 'pending-image' }).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.runtime.sendMessage({ type: 'tab-changed', tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    chrome.runtime.sendMessage({ type: 'tab-changed', tabId }).catch(() => {});
  }
});
