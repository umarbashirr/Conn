/* The slot model in tabs-store. The right column is two slots, the browser
   and the canvas on top and the tools underneath, and each keeps its own
   active tab and its own answer to whether it is up. Every kind belongs to one
   slot, going to a tab in one slot leaves the other slot where it was, and a
   slot puts itself away when its last tab goes without taking the other with
   it.

   Runs under plain node with no app. The renderer stores are ES modules in a
   package that says commonjs, so a resolve hook names them as modules on the
   way in. Run `node scripts/tab-slots-check.mjs`. */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    const found = next(specifier, context);
    return found.url.includes('/src/renderer/') ? { ...found, format: 'module' } : found;
  },
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = (file) => import(pathToFileURL(path.join(ROOT, 'src/renderer/ui/shell', file)).href);
const tabs = await shell('tabs-store.js');
const { layout } = await shell('layout-store.js');

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const { KINDS, SLOTS, SLOT_OF, activeIn, activateTab, closeTab, openTab, showPanel } = tabs;
const slots = () => `top ${layout.topOpen} bottom ${layout.bottomOpen} right ${layout.rightOpen}`;
const active = (dir) => `top ${activeIn?.(dir, 'top')?.id ?? null} bottom ${activeIn?.(dir, 'bottom')?.id ?? null}`;

check('every-kind-has-a-slot', Array.isArray(SLOTS) && KINDS.every((kind) => SLOTS.includes(SLOT_OF?.[kind])), `SLOT_OF ${JSON.stringify(SLOT_OF)} for ${KINDS.join(' ')}`);
check('console-is-a-bottom-kind', SLOT_OF?.console === 'bottom', `SLOT_OF.console ${SLOT_OF?.console}`);
check('browser-and-canvas-are-top-kinds', SLOT_OF?.browser === 'top' && SLOT_OF?.canvas === 'top', `browser ${SLOT_OF?.browser} canvas ${SLOT_OF?.canvas}`);

const dir = '/tmp/slots-check';
showPanel(dir, 'chat-one');
const page = openTab(dir, 'browser');
const term = openTab(dir, 'terminal');
check('page-is-active-on-top', activeIn?.(dir, 'top')?.id === page?.id, active(dir));
check('terminal-is-active-below', activeIn?.(dir, 'bottom')?.id === term?.id, active(dir));
check('both-slots-open', layout.topOpen === true && layout.bottomOpen === true, slots());

const files = openTab(dir, 'files');
check('files-takes-the-bottom-slot', activeIn?.(dir, 'bottom')?.id === files?.id, active(dir));
check('opening-files-leaves-the-page-on-top', activeIn?.(dir, 'top')?.id === page?.id, active(dir));

activateTab(dir, term.id);
check('activating-a-bottom-tab-leaves-the-top-alone', activeIn?.(dir, 'top')?.id === page?.id && activeIn?.(dir, 'bottom')?.id === term?.id, active(dir));

const canvas = openTab(dir, 'canvas');
check('canvas-takes-the-top-slot', activeIn?.(dir, 'top')?.id === canvas?.id, active(dir));
check('opening-canvas-leaves-the-terminal-below', activeIn?.(dir, 'bottom')?.id === term?.id, active(dir));
closeTab(dir, canvas.id);
check('closing-canvas-hands-the-top-back-to-the-page', activeIn?.(dir, 'top')?.id === page?.id && layout.topOpen === true, `${active(dir)}; ${slots()}`);

closeTab(dir, term.id);
check('closing-a-bottom-tab-moves-to-its-neighbour-in-that-slot', activeIn?.(dir, 'bottom')?.id === files?.id, active(dir));
closeTab(dir, files.id);
check('closing-the-last-bottom-tab-collapses-only-the-bottom', layout.bottomOpen === false && layout.topOpen === true, slots());
check('the-column-stays-up-for-the-page', layout.rightOpen === true && activeIn?.(dir, 'top')?.id === page?.id, `${slots()}; ${active(dir)}`);

closeTab(dir, page.id);
check('closing-the-last-top-tab-puts-the-column-away', layout.topOpen === false && layout.bottomOpen === false && layout.rightOpen === false, slots());

showPanel(dir, 'chat-two');
openTab(dir, 'terminal');
check('another-chat-opens-only-its-own-bottom-slot', layout.bottomOpen === true && layout.topOpen === false, slots());
showPanel(dir, 'chat-one');
check('coming-back-restores-that-chat-s-slots', layout.bottomOpen === false && layout.topOpen === false, slots());

console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
process.exit(failures.length ? 1 : 0);
