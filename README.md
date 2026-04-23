# AR Watch Try-On Prototype

This is a browser-based AR watch try-on prototype built with `MediaPipe` and `Three.js`. The goal is to place a 3D watch on the user's wrist in a way that feels natural enough for a product demo: stable wrist anchoring, believable top-view placement, reasonable side rotation, and basic occlusion behavior.

## Why this stack

I explored the usual native AR route first, but this prototype had to run on the web.

- `Unity` was not the best fit for this delivery target because Unity AR Foundation does not directly support `WebGL`.
- Some practical Unity-side hand-tracking options such as `ManoMotion` are commercial SDKs, which adds cost and platform dependency for a fast prototype.
- Because of that, the most direct browser-first path was `MediaPipe` for hand landmarks and `Three.js` for rendering the watch in a web AR-style experience.

So the decision here was not "Unity is bad" - it was simply the wrong tool for a quick web prototype.

## How the prototype works

At a high level, the pipeline is:

1. Start the camera with device-aware defaults.
2. Run MediaPipe Hand Landmarker on each video frame.
3. Select the primary hand and read the wrist and hand-base landmarks.
4. Convert landmark positions from normalized image space into Three.js world space.
5. Build a wrist-aligned local basis from hand direction + wrist surface normal.
6. Smooth the watch transform and render the GLB watch model on top of the video.

Useful code references:

- Camera and startup flow: `app.js:118`, `app.js:143`, `app.js:168`, `app.js:189`
- MediaPipe initialization: `app.js:237`
- Three.js scene setup: `app.js:272`
- Watch rig creation: `app.js:294`
- GLB loading and normalization: `app.js:423`, `app.js:472`, `app.js:506`
- Per-frame tracking loop: `app.js:518`, `app.js:527`, `app.js:545`
- Landmark projection into world space: `app.js:721`

## Wrist pose logic

The wrist alignment is based on a lightweight inferred pose rather than a full anatomical wrist tracker.

- Landmark `0` is used as the wrist anchor.
- The forward / forearm-aligned direction is estimated from `Point 9 - Point 0`.
- The wrist-width direction comes from `Point 17 - Point 5`.
- A cross product gives a surface normal so the watch sits flatter on the wrist instead of floating from one point.
- The final pose is smoothed with lerp and slerp to reduce jitter.

Useful code references:

- Pose extraction: `app.js:545`
- Palm/back inference: `app.js:682`
- Basis stabilization: `app.js:655`
- Watch transform smoothing: `app.js:737`

## What is working well

- Top-view wrist placement is the strongest part of the current prototype.
- Camera start/stop flow works in a simple browser-friendly way.
- On phones, the experience defaults to the rear camera; on desktops, it uses the webcam.
- A real GLB watch model can be loaded from `assets/digital_watch.glb`.
- If the GLB is missing, the app can still fall back to a procedural placeholder.

## Current limitations

This prototype is working, but it is still a prototype.

- `MediaPipe Hand Landmarker` is primarily a hand landmark / gesture tracking system, not a dedicated watch-grade wrist solver.
- Because the wrist pose is inferred from sparse hand landmarks, top views look better than side and back views.
- Side and underside angles can still produce slight roll, offset, or strap alignment issues.
- Occlusion is still heuristic, using a simple depth mask instead of full hand segmentation or true scene depth.
- Scale is estimated from projected wrist span, so it is much better than before, but it is still not the same as true real-world measurement.

In short: the current build proves that web-based AR watch try-on is feasible, but it is not yet a production-grade wearable tracker with using the Mediapipe.

## How this can be improved later

The next step is not really "more Three.js" - it is better wrist understanding.

Best future improvements:

- Use a wrist-specific or wearable-specific tracker instead of a general hand tracker.
- Add better occlusion via segmentation or depth estimation.
- Introduce stronger temporal filtering for difficult side views.
- Add model-specific calibration offsets for different watch assets.
- Use a denser hand or wrist surface model if a better plugin becomes available.

That would make the side-view and back-view behavior much closer to an actual watch wrapped around the wrist.

## Running locally

Serve the project from a local server rather than opening `index.html` directly.

Example:

```powershell
cd C:\Users\avipr\Desktop\WatchTryOn\WatchTryOn
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Camera access requires `localhost` or `HTTPS`.

## GitHub Pages

This repo includes a GitHub Pages workflow:

- `.github/workflows/deploy-pages.yml`

Link:- `https://nagaavi.github.io/WatchTryOn/`

After pushing to `main`, enable GitHub Pages in the repository settings and choose `GitHub Actions` as the source.

## Assets

- Main watch model: `assets/digital_watch.glb`
- Asset notes: `assets/README.md`
