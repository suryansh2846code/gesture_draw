// Minimal service worker. State lives in chrome.storage.sync; the content script
// owns the camera + model (SWs get evicted, so no ML here). This mostly exists to
// seed defaults on install.
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../content/types';

chrome.runtime.onInstalled.addListener(async () => {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  if (!got[SETTINGS_KEY]) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
});
