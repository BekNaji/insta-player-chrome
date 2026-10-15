# insta-player-chrome

A Chrome extension (Manifest V3) that adds a custom video control panel to Instagram videos: feed, Reels, post pages and stories.

## Features

- Play / Pause button
- Progress slider (drag to seek, moves while the video plays)
- Time display (for example `0:05 / 0:30`)
- Speed button: 1x → 1.25x → 1.5x → 2x
- Volume slider and mute button
- Keyboard shortcuts
- Speed and volume are saved and used on the next videos

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / Pause |
| `←` | Go back 5 seconds |
| `→` | Go forward 5 seconds |
| `M` | Mute / Unmute |

Shortcuts are ignored while you type in an input, textarea or comment box.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open [instagram.com](https://www.instagram.com) and refresh the page.

## Project files

```
├── manifest.json   Extension settings (Manifest V3)
├── content.js      Player panel logic
└── style.css       Panel styles
```

## How it works

- It does not use Instagram class names (they change often). It only uses `<video>` elements.
- The panel is added to the page body, outside of Instagram's links, so clicking it never opens a reel.
- Click and touch events on the panel are stopped, so Instagram does not see them.
- A `MutationObserver` (with debounce) finds new videos while you scroll, and each video gets only one panel.
- Settings are stored with `chrome.storage.local`. The only permission needed is `storage`.

## Troubleshooting

- Reload the extension in `chrome://extensions`, then refresh Instagram.
- The panel is hidden on very small videos (under 200×150 px).
- Shortcuts do not work if the cursor is inside a text field.
- If the panel covers something on stories, change `BOTTOM_INSET` or `STORIES_BOTTOM_INSET` at the top of `content.js`.

## Disclaimer

This project is not affiliated with, endorsed by, or connected to Instagram or Meta.

## License

MIT. See [LICENSE](LICENSE).
