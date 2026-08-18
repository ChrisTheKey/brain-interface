# Background asset

The Brain Interface renders one fullscreen background image behind every brain
element. Drop your reference image here:

```
public/assets/brain-background.png
```

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

Until the file exists, a dark radial gradient is used as the fallback so the
brain stays readable. That fallback is deliberately neutral — it is not meant
as a replacement for your image.

`public/assets/brain-background.*` is git-ignored: the image is your asset and
is not committed with the source.
