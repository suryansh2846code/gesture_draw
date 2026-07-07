# ✍️ Gesture Draw

Draw shapes and flowcharts on **Google Meet** using hand gestures tracked from
your webcam. Everything runs **on-device** (MediaPipe Hands in WASM) — no server,
no data leaves the browser.

Two modes, switchable in the popup:

- **On my camera** — the drawing is composited straight onto your webcam feed, so
  everyone sees it live **on your video tile**. No screen-share needed.
- **On my screen** — the drawing is a transparent overlay on your whole screen;
  others see it when you **share your screen**. Good for annotating slides/apps.

## Gestures

| Gesture | Action |
|---|---|
| 🤏 **Pinch** (thumb + index) | Pen down — draw while pinched, release to commit |
| ☝️ **Point** (index only) | Move the cursor without drawing |
| ✋ **Open palm** | Clear the canvas |
| Keyboard `C` / `Z` | Clear / Undo |

On release, a stroke auto-snaps to a rectangle, circle, line or arrow (toggle in
the popup: Auto / Freehand / a fixed shape).

## Build & load

```bash
npm install
npm run fetch-model   # downloads hand_landmarker.task (~7.8 MB) into public/models
npm run build         # outputs dist/
npm test              # optional: headless smoke tests of the core logic
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder
4. Open a call at `meet.google.com`, click the extension icon, pick a **Mode**, **Turn On**
5. Pinch your fingers in view of the webcam and draw.

In **camera mode**, if your camera is already on when you switch, toggle it off/on
once in Meet so it re-requests the (now composited) feed. Use `npm run dev` for a
watch build (then hit "Reload" on the extension card).

## How it works

```
webcam → MediaPipe HandLandmarker (WASM/GPU) → 21 landmarks
       → GestureRecognizer (pinch/point/palm, palm-size normalized + hysteresis)
       → 1€ filter (smoothing) → draw state machine → shape snapping
       → screen overlay   (screen mode)
       → canvas.captureStream fed back into Meet via getUserMedia (camera mode)
```

The engine runs in the page's **MAIN world** (so MediaPipe's WASM loader works and
so we can intercept `getUserMedia`), while a small **isolated bridge** holds the
`chrome.*` APIs. They talk over DOM CustomEvents.

Key source:
- `src/content/engine.ts` — orchestrator, draw state machine, getUserMedia patch
- `src/content/bridge.ts` — isolated-world chrome.* bridge
- `src/content/HandTracker.ts` — MediaPipe wrapper (model/wasm from the bundle)
- `src/content/gestures.ts` — landmark geometry → gesture
- `src/content/OneEuroFilter.ts` — jitter smoothing
- `src/content/shapeSnap.ts` — freehand → clean primitive
- `src/content/Renderer.ts` — screen overlay (Rough.js)
- `src/content/CameraCompositor.ts` — webcam + drawing → output MediaStream
- `src/content/draw.ts` — drawing primitives shared by both renderers
- `src/popup/popup.ts` — controls (writes `chrome.storage.sync`)

## Notes on Google Meet

Getting MediaPipe to run inside Meet took working through three of Meet's layers,
each fixed in its own commit:

1. **Isolated world** — MediaPipe's WASM loader sets `ModuleFactory` in the main
   world; moved the engine there via a `world: "MAIN"` content script.
2. **Trusted Types** — Meet blocks raw-string `<script>.src`; install a
   pass-through default Trusted Types policy.
3. **Camera mode** — intercept `getUserMedia` at `document_start` to hand Meet a
   composited canvas stream.

## Known limitations

- **Google Meet only.** Native Zoom/Teams apps can't be extended; add their web
  origins to `manifest.json` + `web_accessible_resources` to try them.
- **No text labels yet** — planned via keyboard/voice.
- Text/precision are intentionally forgiving (sketchy Rough.js rendering).

## Roadmap

1. Export → PNG / Mermaid / Excalidraw JSON
2. Palm/dwell radial menu for color + shape (no keyboard)
3. Two-hand resize of the last shape
4. AI flowchart cleanup (auto-align boxes, snap arrows to edges)
5. Voice labels ("point + say 'database'")
