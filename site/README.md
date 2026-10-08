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
| `a[data-file="deb\|appimage\|exe"]` | Sets `href` to the release asset and adds `download`. Without that file in the release, it removes `download`, sets `data-absent` and applies the two hooks below. |
| `data-absent-href="#download"` on a `data-file` link | When the file is absent, `href` becomes this value. The link stays clickable. |
| `data-absent-label="Not in this release"` on an element inside a `data-file` link | When the file is absent, the element's text becomes this value and the link gets `aria-disabled="true"` and `tabindex="-1"`. The `href` stays on the releases page. CSS styles `a[data-absent]` as an inactive button. |
| `[data-file-name="..."]` | Sets the text to the asset name. Hidden when the file is absent, because the name in the HTML is the 0.13.3 value. |
| `[data-file-size="..."]` | Sets the text to the size in MB. CSS hides the element while it is empty. Hidden when the file is absent. |
| `[data-hero-note]` | The line under the hero button. Shows the text from `heroOf` when the platform's file is missing from the release, and stays hidden otherwise. |
| `[data-version]` | Sets the text to the release version, without the leading `v`. |
| `[data-for="linux windows other"]` | Hides the element unless the detected platform is listed. |
| `[data-platform="linux\|windows"]` | Sets `data-detected` on the card that matches the platform. CSS draws the "Your system" badge from it. |
| `[data-os]` | Sets the platform name, which is the detected platform on the nav button and the hero look on the hero button. CSS sizes the logo from it. |
| `use[data-logo]` | Points at the platform's logo symbol in the sprite. |
| `.dl-button` | Takes the hero look: `data-os`, label, logo, `href` and `download`. The script also sets `data-state` while the click animation plays. |
| `[data-copy="id"]` | Copies the text of the element with that id, then shows "Copied" for 1.5 seconds. |

Platforms are `linux`, `windows` and `other`. macOS, iOS, Android, ChromeOS and anything unrecognised count as `other`, and the hero button then scrolls to `#download`. The `FILES` table in `download.js` holds, for each file, the pattern that picks the release asset and the noun the page uses for it. The file names and sizes in `index.html` are the 0.13.3 values, and the script replaces them when the release lists that file.

The release has three states. Unknown means the GitHub request has not answered or failed, because of a rate limit or no network. The page keeps what it rendered, with the platform's label and every download link on the releases page. A file that is present gets its asset URL and `download` on every link, and its name and size. A file that is absent gets the treatment its elements declare, and the hero falls back to "See all downloads" with a note such as "The Windows installer isn't in v0.13.3 yet." Uploading a missing file to the release changes the page with no code change.

## How to deploy this folder to Vercel

1. Create a Vercel project from this git repo, or upload this `site/` directory.
2. If the project root is the parent repo, set the Root Directory to `site`.
3. Set Framework Preset to Other.
4. Leave the build command empty.
5. Set the output directory to `.`.
6. Deploy.

Vercel serves `index.html` at `/` and the other files by name.
