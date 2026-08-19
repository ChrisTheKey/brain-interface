# Background asset

The Brain Interface renders one fullscreen background image behind every brain
element. The shipped asset is:

```
public/assets/brain-background.jpg
```

Replace that file to change the backdrop.

Any of `.png`, `.jpg`, `.jpeg`, `.webp` works — if you use a different
extension, point `VITE_ZERO_BACKGROUND_IMAGE` at it, for example:

```
VITE_ZERO_BACKGROUND_IMAGE=/assets/brain-background.jpg
```

How it is rendered (`.background` in `src/styles.css`):

- `position: fixed; inset: 0` — covers the whole viewport, never scrolls
- `background-size: cover` — scales proportionally, no visible borders
- `z-index: 0` — behind the brain canvas (`z-index: 1`) and all panels
- `pointer-events: none` — never intercepts interaction

If the file is missing, a dark radial gradient is used as the fallback so the
brain stays readable.
