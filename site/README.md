# site/

Static landing page. No build and no package. `download.js` is the only script, and it loads with `defer`. The page is complete without it: every download link points at the releases page and the Linux values show.

## Files

- `index.html` is the page. Copy, install commands and the hidden SVG sprite that every icon and logo references live here.
- `styles.css` holds the colour tokens, the layout and the download button states. `--a-*` tokens colour the app window mockup.
- `download.js` detects the visitor's platform, reads the latest GitHub release, and fills in links, file names, sizes and the version. It also plays the download button animation and runs the copy buttons.
- `vercel.json` sets cache headers. It has no rewrites and no build.
- `favicon.png` is the tab icon.

Edit visitor copy in `index.html`. Change an install command in `code#cmd-linux` or `code#cmd-windows`. Every copy button reads its command from the element named in `data-copy`, so the shortened command in the hero chip is display text only. Do not add a macOS command.

## How download.js reads the page

The HTML declares what each element is. The script fills values and changes no layout.

| Hook | What the script does |
| --- | --- |
| `a[data-file="deb\|appimage\|exe"]` | Sets `href` to the release asset and adds `download`. Without that file in the release, the link stays on the releases page. |
| `[data-file-name="..."]` | Sets the text to the asset name. |
| `[data-file-size="..."]` | Sets the text to the size in MB. CSS hides the element while it is empty. |
| `[data-version]` | Sets the text to the release version, without the leading `v`. |
| `[data-for="linux windows other"]` | Hides the element unless the detected platform is listed. |
| `[data-platform="linux\|windows"]` | Sets `data-detected` on the card that matches the platform. CSS draws the "Your system" badge from it. |
| `[data-os]` | Sets the platform name. CSS sizes the logo from it. |
| `use[data-logo]` | Points at the platform's logo symbol in the sprite. |
| `.dl-button` | Sets `href` to the platform's file, and `data-state` while the click animation plays. |
| `[data-copy="id"]` | Copies the text of the element with that id, then shows "Copied" for 1.5 seconds. |

Platforms are `linux`, `windows` and `other`. macOS, iOS, Android, ChromeOS and anything unrecognised count as `other`, and the hero button then scrolls to `#download`. The `FILES` patterns in `download.js` pick the release assets. The file names and sizes in `index.html` are the 0.13.3 values, and the script replaces them when the release lists that file.

If the GitHub request fails, because of a rate limit or no network, the page keeps what it rendered. The platform still applies.

`download.js` puts `platformOf`, `releaseOf` and `mb` on `window` so they can be tested in a browser console.

## How to deploy this folder to Vercel

1. Create a Vercel project from this git repo, or upload this `site/` directory.
2. If the project root is the parent repo, set the Root Directory to `site`.
3. Set Framework Preset to Other.
4. Leave the build command empty.
5. Set the output directory to `.`.
6. Deploy.

Vercel serves `index.html` at `/` and the other files by name.
