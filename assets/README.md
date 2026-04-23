# Assets

- Add a watch model at `assets/digital_watch.glb` to replace the procedural watch head.
- The loader also falls back to `assets/Watch.glb` for compatibility with older tests.
- The runtime assumes the watch length points roughly along local `+Y` and the dial faces local `+Z`.
- If your model imports rotated, correct it once in the asset or add a small corrective transform inside `app.js`.
- Strap geometry is currently procedural so the prototype stays usable even before a final product model is ready.
