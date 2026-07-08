// Popup UI: reads/writes settings in chrome.storage.sync (content script reacts
// to storage changes) and pokes the active Meet tab for actions + live status.
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Msg, type Settings } from '../content/types';

const COLORS = ['#ff375f', '#0a84ff', '#30d158', '#ffd60a', '#ffffff', '#1c1c1e'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings = { ...DEFAULT_SETTINGS };

async function load(): Promise<Settings> {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] ?? {}) };
}

async function save(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

async function activeMeetTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://meet.google.com/')) return tab;
  return null;
}

async function sendToTab(msg: Msg): Promise<any> {
  const tab = await activeMeetTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null; // content script not loaded (e.g. lobby page)
  }
}

function renderSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  for (const c of COLORS) {
    const el = document.createElement('div');
    el.className = 'sw' + (c === settings.color ? ' active' : '');
    el.style.background = c;
    if (c === '#1c1c1e') el.style.border = '2px solid #444';
    el.onclick = async () => {
      await save({ color: c });
      renderSwatches();
    };
    box.appendChild(el);
  }
}

function renderToggle() {
  const btn = $<HTMLButtonElement>('toggle');
  btn.textContent = settings.enabled ? 'Turn Off' : 'Turn On';
  btn.classList.toggle('off', !settings.enabled);
}

function renderModeHint() {
  const el = $('modeHint');
  el.textContent =
    settings.mode === 'camera'
      ? 'Draws on your webcam tile — everyone sees it live. If your camera is already on, toggle it off/on once after switching.'
      : 'Draws over your whole screen — others see it only when you share your screen.';
}

async function refreshStatus() {
  const box = $('status');
  const tab = await activeMeetTab();
  if (!tab) {
    box.className = 'status';
    box.textContent = 'Open a Google Meet call to use Gesture Draw.';
    return;
  }
  const reply = (await sendToTab({ type: 'action:status' })) as
    | { running: boolean; error?: string }
    | null;
  if (!reply) {
    box.className = 'status';
    box.textContent = 'Waiting for the Meet tab… reload the tab if this persists.';
  } else if (reply.error) {
    box.className = 'status err';
    box.textContent = `Camera/tracking error: ${reply.error}`;
  } else if (reply.running) {
    box.className = 'status ok';
    box.textContent = '● Running — pinch your fingers to draw.';
  } else {
    box.className = 'status';
    box.textContent = 'Idle. Turn on to start hand tracking.';
  }
}

async function main() {
  settings = await load();

  renderSwatches();
  renderToggle();
  renderModeHint();
  ($('mode') as HTMLSelectElement).value = settings.mode;
  ($('drawHand') as HTMLSelectElement).value = settings.drawHand;
  ($('shape') as HTMLSelectElement).value = settings.shapeMode;
  ($('smoothing') as HTMLInputElement).value = String(settings.smoothing);
  ($('pinch') as HTMLInputElement).value = String(settings.pinchThreshold);
  ($('debug') as HTMLInputElement).checked = settings.showDebug;

  $('toggle').onclick = async () => {
    await save({ enabled: !settings.enabled });
    renderToggle();
    setTimeout(refreshStatus, 400);
  };
  $('mode').onchange = async (e) => {
    await save({ mode: (e.target as HTMLSelectElement).value as any });
    renderModeHint();
  };
  $('drawHand').onchange = (e) => save({ drawHand: (e.target as HTMLSelectElement).value as any });
  $('shape').onchange = (e) => save({ shapeMode: (e.target as HTMLSelectElement).value as any });
  $('smoothing').onchange = (e) => save({ smoothing: Number((e.target as HTMLInputElement).value) });
  $('pinch').onchange = (e) => save({ pinchThreshold: Number((e.target as HTMLInputElement).value) });
  $('debug').onchange = (e) => save({ showDebug: (e.target as HTMLInputElement).checked });
  $('undo').onclick = () => sendToTab({ type: 'action:undo' });
  $('clear').onclick = () => sendToTab({ type: 'action:clear' });

  await refreshStatus();
  setInterval(refreshStatus, 1500);
}

main();
