---
name: input-replay
description: Real-user wheel, trackpad, swipe, and tap input replayed into a web page at measured device timing, in desktop Chromium or Android Chrome. Use when checking how a page reacts to scroll or touch gestures, such as a carousel, a horizontal scroller, or scroll snapping ("휠로 넘겨봐", "트랙패드 관성 재현해줘", "스와이프 테스트", "터치로 확인해줘").
---

# input-replay

`scripts/replay.mjs` in this skill's directory sends the input over the Chrome DevTools protocol. `node <skill dir>/scripts/replay.mjs --help` is the reference for steps and options. It needs Node 22+ and a Chromium: Playwright's (`npx playwright install chromium`) or Google Chrome.

## Replay

1. Pick one step per behaviour the question names. Trackpad flick with its inertia tail: `trackpad`. Mouse wheel: `mouse` (one notch), `mouse-fast` (a quick roll), `mouse-hold` (steady rolling). A finger that leaves at speed: `swipe`. One that stops before lifting: `drag`. A recorded gesture: `wheel:<file.json>`, samples `{dt, dx, dy}` with `dt` in ms from the first sample. Done when every behaviour in the question has a step.
2. Write `--read` as an expression returning the state the question is about: the active slide, `scrollLeft`, which video plays. It runs more than once per step, so it only reads. Done when the `start` line shows the value you expect before any input.
3. Run it once per width the project checks:

   ```bash
   node <skill dir>/scripts/replay.mjs <url> --viewport 375x812 --at '<scroller css>' --read '<js>' swipe:-200,0 swipe:200,0
   ```

   Each step prints one JSON line with `sent` events, `got` (events the page received, by type), `missed`, `ms`, and `read`. Touch steps add `readAtLift`, the `--read` value as the finger lifts. Done when every step line shows `missed: 0` and a `got` count for its input.

Each step starts where the previous one left the page. To measure one gesture from the initial state, give it a run of its own.

`missed` counts events that landed outside `--at`: something covers the target, or it moved. Fix that before trusting `read`. `got` below `sent` is Chrome coalescing events while the main thread is busy, which happens with real input too.

Movement between `readAtLift` and `read` is fling plus snapping. On a scroll-snap scroller the snap also moves after the lift, and `scroll-snap-stop: always` caps a gesture at one item, so `swipe` and `drag` can end in the same place. Read the snap CSS before calling a fling missing.

A step ends after 500 ms without scroll. A page that keeps animating needs `--wait '<js true once settled>'`. Use `--headed` to watch and `--shot <file.png>` for the end state.

## Android Chrome

For a mobile user agent, real DPR, and Android scroll physics, attach to Chrome on an emulator. The script opens its own tab and closes it at the end. Check first that no one else is driving the emulator: `pgrep -fl 'agent-device|screenrecord'` prints nothing.

```bash
adb reverse tcp:<port> tcp:<port>    # the device's localhost:<port> reaches the Mac's dev server
adb forward tcp:9341 localabstract:chrome_devtools_remote
node <skill dir>/scripts/replay.mjs http://localhost:<port>/<path> --cdp http://127.0.0.1:9341 --at '<css>' --read '<js>' swipe:-200,0
adb forward --remove tcp:9341
```

Verified on an API 34 emulator with Chrome 113:

- Start the emulator with `emulator -avd <avd> -gpu host -cores 4 -memory 4096 -no-snapshot-load &`. With the software GPU (`-gpu swiftshader_indirect`) and one core, a page took about 15 s to draw, and gestures ran on a half-drawn page.
- A white page means Chrome's GPU process crashed. Run `adb shell "echo '_ --disable-features=Vulkan' > /data/local/tmp/chrome-command-line"`, then `adb shell am force-stop com.android.chrome`. Only debuggable images such as the emulator read this file, and it survives reboots.
- Chrome's first-run screen needs one pass by hand.
- Only 3 or 4 of a swipe's 12 `touchmove` events arrive, but the lift speed still flings.
- To record the screen at real speed:

  ```bash
  adb shell 'screenrecord --bit-rate 8000000 --time-limit 120 /sdcard/replay.mp4 >/dev/null 2>&1 & echo $! > /sdcard/replay.pid'
  # run replay.mjs
  adb shell 'kill -2 $(cat /sdcard/replay.pid)'    # the file finishes writing about 2 s later
  adb pull /sdcard/replay.mp4
  ```

## Limits

Report these with any result, since a pass here is not a pass on a real device.

- Wheel events carry no OS gesture phase, so Chrome adds no native momentum or smooth scrolling; the inertia is the event stream itself. A carousel that moved twice under a real Mac mouse wheel passed with these streams. A real mouse and trackpad give the final answer.
- `wheelDeltaX` and `wheelDeltaY` are a fixed ±120 per event, or a multiple when Chrome merges events, while a real trackpad scales them with the delta. Code that reads them, not `deltaX` and `deltaY`, sees different values.
- The mouse streams come from one mouse on Mac Chrome. Other mice and scroll settings send other sizes: record the device in question and replay it with `wheel:<file>`.
- Desktop touch is emulation on the desktop page: desktop user agent, `mobile: false`, the screen's DPR. Mobile layout and physics come from Android Chrome.
- Safari has no DevTools protocol, and Playwright's desktop WebKit is not iOS Safari. Check iOS by hand in Simulator or on a phone.
