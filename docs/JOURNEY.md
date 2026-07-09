# Gesture Draw — Project Journey

A full record of what this project is, why it's built the way it is, and every
obstacle we hit and solved along the way. Written to be read start-to-finish.

---

## 1. What it is

A **Chrome extension** that lets you draw shapes, flowcharts, and handwritten
letters/numbers **on a Google Meet call using hand gestures** tracked from your
webcam. Everything runs **on-device** — MediaPipe hand tracking in WebAssembly,
a canvas overlay, and an on-device character recognizer. No server, no data
leaves the browser.

Two modes:
- **On my camera** — the drawing is composited straight onto your webcam feed,
  so it appears on your video tile live, no screen-share needed.
- **On my screen** — the drawing is a transparent overlay on your whole screen;
  others see it when you share your screen (good for annotating slides/apps).

---

## 2. The idea & the first decision

The original idea: "use hand gestures in video chats to draw shapes and
flowcharts." The first and most important decision was recognizing that this is
really **two different products**:

- **Version A — local overlay.** You draw on your own screen/camera; others see
  it via screen-share or your video tile. Pure client side.
- **Version B — shared whiteboard.** Everyone in the call sees strokes appear
  live from anyone's hands. Needs a sync backend, presence, conflict handling —
  a real distributed-systems project.

We chose **Version A** deliberately: ~90% of the "wow" for ~10% of the effort,
and a good way to validate the interaction before investing in multiplayer.

---

## 3. High-level architecture

```
webcam ─▶ MediaPipe HandLandmarker (WASM/GPU) ─▶ 21 landmarks/hand
       ─▶ GestureRecognizer (palm-size-normalized geometry + hysteresis)
       ─▶ 1€ filter (jitter smoothing)
       ─▶ draw state machine (draw / erase / grab-move / recognize)
       ─▶ shape snapping ($ char recognition for text)
       ─▶ SCREEN overlay        (screen mode)
       ─▶ canvas.captureStream fed back into Meet via getUserMedia (camera mode)
```

The extension is split across three contexts because of how Chrome and Meet
work:

- **`engine.ts` — page MAIN world.** The whole camera + MediaPipe + overlay
  engine. Runs in the page's main world (see §4.1) and has **no** `chrome.*`
  access.
- **`bridge.ts` — isolated world.** The only part with `chrome.*` (storage,
  popup messaging). Stamps the extension base URL onto `<html data-gd-base>` and
  relays settings/actions to the engine over DOM CustomEvents.
- **`sw.ts` — service worker.** Minimal; seeds default settings on install.
- **`popup.ts`** — the control panel (writes `chrome.storage.sync`).

Tooling: **esbuild + TypeScript** (no Vite/CRXJS — fewer moving parts, faster,
fully controlled). MediaPipe WASM + the hand model are **bundled** as
web-accessible resources and never fetched from a CDN at runtime.

---

## 4. The journey — obstacles and how we solved them

Getting MediaPipe to run *inside* Google Meet meant peeling through three layers
of Meet's security, each fixed in its own commit. This is the interesting part.

### 4.1 "ModuleFactory not set" — isolated vs. main world

**Symptom:** tracking threw `ModuleFactory not set`.

**Cause:** MediaPipe loads its WASM glue by appending a `<script>` to the page.
That script executes in the page's **main world** and sets `ModuleFactory`
there — but our content script ran in the **isolated world**, where
`ModuleFactory` stayed undefined.

**Fix:** split into two content scripts — a MAIN-world `engine.ts` (all the ML +
rendering) and an isolated `bridge.ts` (the `chrome.*` APIs), talking over DOM
CustomEvents. This is the standard MediaPipe-in-an-extension pattern.

### 4.2 "TrustedScriptURL required" — Trusted Types

**Symptom:** after the world fix, MediaPipe got further but hit
`This document requires 'TrustedScriptURL' assignment`.

**Cause:** Meet enforces `require-trusted-types-for 'script'`, so assigning a raw
string to `<script>.src` (which MediaPipe's loader does) is blocked.

**Fix:** install a **pass-through default Trusted Types policy** before MediaPipe
loads. A default policy only fires for raw-string sink assignments, which Meet's
own Trusted-Types-compliant code never makes — so it unblocks MediaPipe without
changing Meet's behavior. This was the moment it first worked: 30fps, live hand
tracking on Meet.

### 4.3 Camera-overlay mode — intercepting getUserMedia

Version A originally only did a screen overlay (share your screen to be seen).
To put the drawing **on your webcam tile**, we intercept
`navigator.mediaDevices.getUserMedia` in the main world: when Meet requests the
camera, we return a **canvas stream** that composites `webcam + drawing`, with
Meet's audio track passed through untouched. The real `getUserMedia` is stashed
so our own tracking camera isn't recursively composited.

### 4.4 "appendChild of null" — document_start timing

**Symptom:** enabling threw `Cannot read properties of null (reading
'appendChild')`.

**Cause:** to install the getUserMedia patch *before* Meet grabs the camera, the
scripts run at `document_start`. But if the extension was already enabled, it
auto-started immediately — before `<body>` existed — and MediaPipe's loader tried
`document.body.appendChild(...)`.

**Fix:** keep the patch early, but **wait for `<body>`** before starting the
heavy pipeline.

### 4.5 Blank/frozen webcam — detached elements

**Cause:** the compositor's `<video>` and `<canvas>` weren't in the DOM. Several
browsers won't decode/play a detached `<video>` or capture a detached `<canvas>`,
so the composite was blank or hung.

**Fix:** attach both to the DOM (kept invisible), plus a timeout so the load
never hangs.

### 4.6 Drawing quality — shimmer, gaps, and sync

Once it drew, three quality problems surfaced:

- **Per-frame shimmer.** In camera mode, committed shapes were re-rasterized with
  Rough.js every frame, so they flickered. **Fix:** cache committed shapes on a
  separate **ink layer** repainted only on change; the compositor just stamps
  that bitmap each frame.
- **Gappy, angular freehand.** Rough.js paths and straight-segment polylines look
  broken. **Fix:** render freehand as **smooth quadratic strokes**.
- **Cursor off the fingertip.** Tracking used a second 640×480 camera open while
  the compositor used Meet's (possibly 16:9) stream — different aspect ratios
  pushed the cursor off. **Fix:** in camera mode, track from the **same
  composited stream**, so landmarks line up exactly.
- **Jitter.** Added a **"Smoothing" slider** driving the 1€ filter parameters.

### 4.7 Gesture redesign — pinch was unreliable

Drawing was originally triggered by **pinch** (thumb-to-index distance), which is
finicky and kept failing. We redesigned around a more robust, two-hand scheme:

- **Two-hand tracking** (`numHands: 2`) with handedness.
- **Draw hand pointing (index up) = draw** — far more reliable than pinch.
- **Other hand pointing = erase** ink under the fingertip.
- **"Draw hand" Right/Left toggle** — MediaPipe handedness can read mirror-
  flipped, so it's user-swappable.

### 4.8 Select/move — fist, not pinch

First attempt used pinch to grab a shape, but pinch fired constantly while
pointing to draw (thumb drifting near the index). **Fix:** grabbing is now a
**closed fist** (index down). Because drawing needs the index UP and grabbing
needs it DOWN, the two can never collide.

### 4.9 Handwriting — $1 → $P, then timing, then mirroring

- **v1: $1 single-stroke recognizer.** Templates for 0–9 and A–Z. Worked for
  digits; letters were best-effort.
- **Recognize on pause.** It used to recognize the instant the pen lifted, so a
  tracking flicker committed a half-drawn stroke ("guessing before you finished").
  Now strokes are **buffered** and only recognized after a real pause — which
  also enables **multi-stroke characters** (A, E, T, 4…).
- **v2: $P point-cloud recognizer.** Upgraded to $P (Vatavu/Anthony/Wobbrock),
  which is **stroke-order and stroke-count invariant**, plus multi-stroke
  templates. Validated 11/11 on noisy glyphs including reversed stroke order.
- **Mirror fix.** In camera mode strokes are recorded in the un-mirrored camera
  frame, but you draw watching your mirrored self-view — so a drawn "S" was
  recorded backwards, causing misreads and flipped glyphs. **Fix:** flip the
  stroke horizontally before recognition, and mirror the rendered glyph so it
  reads correctly in the self-view.

---

## 5. Current gesture scheme

| Hand | Gesture | Action |
|---|---|---|
| Draw hand (default Right) | ☝️ index up | **Draw** |
| Draw hand | ✊ closed fist near a shape | **Grab & move** (open to drop) |
| Draw hand | lower finger / pause | pen up (commits / recognizes on pause) |
| Other hand | ☝️ index up | **Erase** ink under the fingertip |
| Keyboard | `C` / `Z` | Clear all / Undo |

Popup controls: On/Off · Mode (camera/screen) · Draw hand (R/L) · Color · Shape
(Auto-snap / Freehand / **Text A–Z 0–9** / Rectangle / Circle / Line / Arrow) ·
Smoothing · Pinch sensitivity · Debug overlay · Undo · Clear.

---

## 6. File map

```
src/content/
  engine.ts          orchestrator (MAIN world): camera, loop, draw/erase/grab,
                     getUserMedia patch, Trusted Types policy, recognition timing
  bridge.ts          isolated world: chrome.* + DOM-event bridge
  CameraManager.ts   our own low-res tracking webcam (screen mode)
  CameraCompositor.ts  webcam + drawing -> canvas.captureStream (camera mode)
  HandTracker.ts     MediaPipe HandLandmarker wrapper (2 hands + handedness)
  gestures.ts        landmarks -> gesture (point/pinch/palm/fist) + hysteresis
  OneEuroFilter.ts   1€ jitter smoothing (+ smoothing slider mapping)
  shapeSnap.ts       freehand stroke -> clean rect/circle/line/arrow
  recognize.ts       $P point-cloud char recognizer (teach-mode ready)
  hitTest.ts         shape hit-test / bbox / translate (erase + select/move)
  draw.ts            shared drawing primitives (shapes, smooth strokes, cursor,
                     eraser, selection, text, HUD)
  Renderer.ts        screen overlay (static + live canvases)
  types.ts           Shape / Settings / RenderState models
src/popup/popup.ts   popup controls
src/background/sw.ts service worker (seeds defaults)
scripts/             build.mjs, fetch-model.mjs, gen-icons.mjs
tests/smoke.ts       headless tests for gesture math, snapping, 1€ filter
```

---

## 7. Key decisions & tradeoffs

- **On-device everything.** Privacy is a selling point; no cloud recognition.
- **esbuild over Vite/CRXJS.** Fewer moving parts, full control of the bundle.
- **Bundle the model + WASM.** Reliability + offline + no CDN dependency (~7.8 MB
  model, gitignored; fetched via `npm run fetch-model`).
- **Camera mode is "drawer-oriented."** Because the cursor must sit on your hand
  in your (mirrored) self-view, the drawing is oriented for *you*; other
  participants see it mirrored. For others-first annotation, **screen mode** is
  the right tool. (A "mirror output" toggle is a possible future option.)
- **`O` vs `0`** are the same shape — inherently ambiguous to any recognizer.

---

## 8. Known limitations

- **Google Meet web only.** Native Zoom/Teams apps can't be extended.
- **Camera mode needs one Meet camera off/on toggle** after switching, so Meet
  re-requests the (now composited) feed.
- **Air-writing accuracy is inherently hard.** Digits are reliable; letters are
  improving. Real air-writing is messier than idealized templates.
- **No text labels by keyboard yet** (handwriting is the text path).

---

## 9. Roadmap

1. **Teach mode** — opt-in: draw each character once, it learns *your* air-writing
   style (personal templates in `chrome.storage`, fed via
   `recognize.setUserTemplates`). Biggest per-user accuracy win, stays offline,
   and doubles as a training-data flywheel. (Template format is already ready.)
2. **Custom trajectory model** — once teach-mode data exists, train a small
   sequence model (beats a bundled EMNIST image-CNN, which transfers poorly from
   paper to air-writing).
3. Export → PNG / Mermaid / Excalidraw JSON.
4. Palm/dwell radial menu for color + shape (no keyboard).
5. Version B — shared multi-user whiteboard.

---

## 10. Build & run

```bash
npm install
npm run fetch-model   # downloads hand_landmarker.task (~7.8 MB)
npm run build         # outputs dist/
npm test              # headless core-logic tests

# then: chrome://extensions -> Developer mode -> Load unpacked -> dist/
# open meet.google.com, click the icon, pick a Mode, Turn On.
```

---

*This document is maintained alongside the code. The commit history mirrors the
journey above — each obstacle and feature is its own commit.*
