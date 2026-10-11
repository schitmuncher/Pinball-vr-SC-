# Space Cadet Pinball VR

3D Pinball – Space Cadet as a WebXR table for Meta Quest. It runs the real decompiled game engine
(compiled to WebAssembly), so the physics, rules, missions and scoring are the original game's. The
table is rebuilt in 3D from the game's own per-pixel depth maps, so the art is the original art with
real height: ramps, walls, bumpers and flippers stand up off the playfield, and the ball is a real
chrome sphere.

## Playing

1. Open the page in the Meta Quest browser.
2. Choose your game files once: the Pinball-on-Android APK, a zip of your Windows Pinball folder,
   or the files themselves (PINBALL.DAT plus the .WAV and .MID files). They stay in the browser.
3. Press **Play in VR**, or **Play in your room** for passthrough.

| Quest controls | |
|---|---|
| Triggers or grips | Flippers |
| A or X (hold, then let go) | Plunger |
| Right stick flick | Nudge left / right / up |
| B | Pause |
| Y | New game |
| Left stick up/down | Table height |
| Left stick click | Move the table in front of you |

On a computer: Z and / flip, Space is the plunger, X . and ↑ nudge, F2 new game, P pause.
On a phone: tap the left or right side to flip, hold the middle to launch.

## Hosting on GitHub Pages

The game is the static files at the root of this repo. In Settings, Pages, set the source to the
`main` branch and the root folder. No game data is included; each player loads their own copy.

## Rebuilding the engine

`engine/` holds the engine source (MIT, from k4zmu2a/SpaceCadetPinball via fexed/Pinball-on-Android)
with a small SDL replacement in `engine/shim/`. Build with clang and the WASI sysroot:

```
WASI_SYSROOT=/path/to/wasi-sysroot ./engine/build.sh
```

## Licences

Engine: MIT (see `engine/LICENSE-engine`). three.js: MIT (`vendor/LICENSE-three`).
The game's art, sounds and music belong to Microsoft and are not part of this project.
