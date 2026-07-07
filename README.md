# ✍️ Gesture Draw (Version A — local overlay)

Draw shapes and flowcharts on **Google Meet** using hand gestures tracked from
your webcam. Everything runs **on-device** (MediaPipe Hands in WASM) — no server,
no data leaves the browser. Others see your drawing when you **share your screen**.

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
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `dist/` folder
4. Open a call at `meet.google.com`, click the extension icon, **Turn On**
5. Pinch your fingers in view of the webcam and draw. Share your screen so others see it.

Use `npm run dev` for a watch build (then hit "Reload" on the extension card).

## How it works

```
webcam → MediaPipe HandLandmarker (WASM/GPU) → 21 landmarks
       → GestureRecognizer (pinch/point/palm, palm-size normalized + hysteresis)
       → 1€ filter (smoothing) → DrawStateMachine → shape snapping
       → transparent overlay canvas (static + live layers)
```

Key source:
- `src/content/index.ts` — orchestrator + draw state machine
- `src/content/HandTracker.ts` — MediaPipe wrapper (model/wasm from bundled resources)
- `src/content/gestures.ts` — landmark geometry → gesture
- `src/content/OneEuroFilter.ts` — jitter smoothing
- `src/content/shapeSnap.ts` — freehand → clean primitive
- `src/content/Renderer.ts` — Rough.js overlay
- `src/popup/popup.ts` — controls (writes `chrome.storage.sync`)

## Known limitations / risks (V1)

- **Google Meet only.** Native Zoom/Teams apps can't be extended; add their web
  origins to `manifest.json` + `web_accessible_resources` to try them.
- **Camera sharing.** Meet already holds the camera; we open a second low-res
  (640×480) consumer of the same device. Most Chrome builds allow this; if it
  fails, the popup shows the error. Camera permission is inherited from Meet's
  origin, so there's usually no extra prompt.
- **Page CSP.** Content scripts bypass page CSP for their own resources, so WASM
  loads fine on Meet. If a future site blocks it, move inference into an
  offscreen document (noted in the spec).
- **No text labels yet** — planned via keyboard/voice (Version A, phase 5).
- Text/precision are intentionally forgiving (sketchy Rough.js rendering).

## Roadmap (next)

1. Export → PNG / Mermaid / Excalidraw JSON
2. Palm/dwell radial menu for color + shape (no keyboard)
3. Two-hand resize of the last shape
4. AI flowchart cleanup (auto-align boxes, snap arrows to edges)
5. Voice labels ("point + say 'database'")
