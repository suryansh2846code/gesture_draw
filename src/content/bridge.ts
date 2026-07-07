// Isolated-world bridge: the only part with chrome.* access. It stamps the
// extension base URL onto <html> for the main-world engine, mirrors settings
// from chrome.storage into the engine via DOM CustomEvents, relays popup
// actions, and caches engine status to answer popup status polls.
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Msg, type Settings } from './types';

const EV_READY = 'gd:engine-ready';
const EV_CMD = 'gd:cmd';
const EV_STATUS = 'gd:status';

let status: { running: boolean; error?: string } = { running: false };

// give the main-world engine the absolute base URL for wasm/model
document.documentElement.dataset.gdBase = chrome.runtime.getURL('');

async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] ?? {}) };
}

function sendToEngine(detail: unknown) {
  window.dispatchEvent(new CustomEvent(EV_CMD, { detail }));
}

async function pushSettings() {
  sendToEngine({ kind: 'settings', settings: await loadSettings() });
}

// engine announces readiness -> send it the current settings
window.addEventListener(EV_READY, () => void pushSettings());

// engine reports running/error -> cache for popup
window.addEventListener(EV_STATUS, (e) => {
  status = (e as CustomEvent<{ running: boolean; error?: string }>).detail;
});

// storage changes (from popup) -> forward whole settings to engine
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[SETTINGS_KEY]) void pushSettings();
});

// popup messages
chrome.runtime.onMessage.addListener((msg: Msg, _s, reply) => {
  switch (msg.type) {
    case 'action:clear':
      sendToEngine({ kind: 'clear' });
      break;
    case 'action:undo':
      sendToEngine({ kind: 'undo' });
      break;
    case 'action:status':
      break; // just report cached status below
  }
  reply({ type: 'status:reply', running: status.running, error: status.error });
  return true;
});

// in case the engine loaded and fired READY before this listener attached
void pushSettings();
