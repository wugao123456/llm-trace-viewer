/**
 * Chrome Extension Background Service Worker
 * Opens the trace viewer in a new tab when the extension icon is clicked.
 */

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "index.html" });
});
