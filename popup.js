// Get the current tab's URL and display it
chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
  const currentTab = tabs[0];
  const url = currentTab.url;
  document.getElementById('url').textContent = url;
});