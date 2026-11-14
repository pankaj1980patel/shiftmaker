import { readPosition } from './utils/location.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'get_location') {
    readPosition().then(sendResponse);
    return true; // async response
  }
});
