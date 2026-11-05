# Mobile Web Guitar Tuner

Vanilla ES modules for Safari iOS, Chrome Android, and mobile webviews.

## Files

- `index.html` — layout, SVG gauge, start overlay, string row
- `styles.css` — fullscreen `#0066FF` theme, safe areas, 7-segment display
- `AudioEngine.js` — Web Audio pipeline, RMS gate, autocorrelation
- `UIController.js` — RAF loop, string tuning, needle + in-tune state

## Run

```bash
npx serve .
```

Open via HTTPS or `localhost` for microphone access.

## PWA (offline + updates)

Install via **Add to Home Screen** after one online visit. Cached assets work offline; tuning stays on-device.

On deploy, bump `VERSION` in `sw.js`. Updates install in the background; the app may refresh once when a new worker takes over (no manual reload banner — works reliably on iOS Home Screen).
