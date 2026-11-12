# site/

Static landing page. No build and no package. Two scripts load with `defer`, and the page is complete without either: every download link points at the releases page, the Linux values show, and the hero demo shows its finished state.

## Files

- `index.html` is the page. Copy, install commands, social meta tags and the hidden SVG sprite that every icon and logo references live here.
- `styles.css` holds the colour tokens, the layout and the download button states. The page is warm paper (`--paper`) with ink text and one orange accent (`--accent`). Orange is a fill only: text on paper that needs the accent uses `--accent-ink`, because `--accent` fails contrast as text. `--w-*` tokens colour the dark app window mockups.
- `download.js` detects the visitor's platform, reads the latest GitHub release, and fills in links, file names, sizes and the version. It also plays the download button animation and runs the copy buttons.
- `page.js` runs the hero demo loop, the permission mode tabs and the scroll reveals. It adds `motion` to `<html>` unless the visitor prefers reduced motion. Every motion rule in the CSS is scoped to `html.motion`, so without it the page renders still and complete.
- `og.png` is the 1200x630 social preview image.
- `vercel.json` sets cache headers. It has no rewrites and no build.
- `favicon.png` is the tab icon.

Edit visitor copy in `index.html`. Change an install command in `code#cmd-linux` or `code#cmd-windows`. Every copy button reads its command from the element named in `data-copy`. Do not add a macOS command.

`og:image` and `twitter:image` use the relative path `og.png`. Some crawlers only accept an absolute URL, so once the site has a domain, change both to `https://<domain>/og.png`.

## The hero demo

`figure[data-demo]` is a scripted loop. Each element with `data-at="N"` appears at step N. `page.js` holds the step times in `STEPS`, sets `data-phase` (`change`, `look`, `verify`, `done`) for the three numbered pills, and toggles `fixed`, `picked`, `clicking`, `loading`, `shot` and `pressed` on the figure for the browser pane. The loop stops and shows the finished state when it scrolls out of view, when the tab is hidden, or when the visitor presses Pause.

## How download.js reads the page

The HTML declares what each element is. The script fills values and changes no layout.

| Hook | What the script does |
| --- | --- |
| `a[data-file="deb\|appimage\|exe"]` | Sets `href` to the release asset and adds `download`. Without that file in the release, it removes `download`, sets `data-absent` and applies the two hooks below. |
| `data-absent-href="#download"` on a `data-file` link | When the file is absent, `href` becomes this value. The link stays clickable. |
| `data-absent-label="Not in this release"` on an element inside a `data-file` link | When the file is absent, the element's text becomes this value and the link gets `aria-disabled="true"` and `tabindex="-1"`. The `href` stays on the releases page. CSS styles `a[data-absent]` as an inactive button. |
| `[data-file-name="..."]` | Sets the text to the asset name. Hidden when the file is absent, because the name in the HTML is the 0.19.2 value. |
| `[data-file-size="..."]` | Sets the text to the size in MB. CSS hides the element while it is empty. Hidden when the file is absent. |
| `[data-hero-note]` | The line under the hero button. Shows the text from `heroOf` when the platform's file is missing from the release, and stays hidden otherwise. |
| `[data-version]` | Sets the text to the release version, without the leading `v`. |
| `[data-for="linux windows other"]` | Hides the element unless the detected platform is listed. |
| `[data-platform="linux\|windows"]` | Sets `data-detected` on the card that matches the platform. CSS draws the "Your system" badge from it. |
| `[data-os]` | Sets the platform name, which is the detected platform on the nav button and the hero look on the hero button. CSS sizes the logo from it. |
| `use[data-logo]` | Points at the platform's logo symbol in the sprite. |
| `.dl-button` | Takes the hero look: `data-os`, label, logo, `href` and `download`. The script also sets `data-state` while the click animation plays. |
| `[data-copy="id"]` | Copies the text of the element with that id, then shows "Copied" for 1.5 seconds. |

Platforms are `linux`, `windows` and `other`. macOS, iOS, Android, ChromeOS and anything unrecognised count as `other`, and the hero button then scrolls to `#download`. The `FILES` table in `download.js` holds, for each file, the pattern that picks the release asset and the noun the page uses for it. The file names in `index.html` are the 0.19.2 values and the sizes start empty. The script fills both when the release lists that file.

The release has three states. Unknown means the GitHub request has not answered or failed, because of a rate limit or no network. The page keeps what it rendered, with the platform's label and every download link on the releases page. A file that is present gets its asset URL and `download` on every link, and its name and size. A file that is absent gets the treatment its elements declare, and the hero falls back to "See all downloads" with a note such as "The Windows installer isn't in v0.19.2 yet." Uploading a missing file to the release changes the page with no code change.

## How to deploy this folder to Vercel

1. Create a Vercel project from this git repo, or upload this `site/` directory.
2. If the project root is the parent repo, set the Root Directory to `site`.
3. Set Framework Preset to Other.
4. Leave the build command empty.
5. Set the output directory to `.`.
6. Deploy.

Vercel serves `index.html` at `/` and the other files by name.

## How to deploy this folder to Hostinger

Upload the contents of this folder, not the folder itself, into the site's `public_html`. Only these files go up: `index.html`, `styles.css`, `download.js`, `page.js`, `og.png`, `favicon.png` and `.htaccess`. Leave out `README.md` and `vercel.json`.

`.htaccess` does what `vercel.json` does on Vercel: it makes browsers re-check every file on each visit, so an update shows up at once. It also turns off directory listings. It is a dotfile, so turn on hidden files in the File Manager, or in your FTP client, to see it.

Do not point Hostinger's Git deployment at this repository. It deploys the whole repository into `public_html`, which would publish the app source and scripts along with the page.

Turn on SSL and Force HTTPS in hPanel. The page loads its fonts from Google Fonts and its release data from the GitHub API, both over HTTPS.
