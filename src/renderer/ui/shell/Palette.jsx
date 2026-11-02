/* One box for everything the window can be asked to do.

   The rail searches chats, the chip switches folders, the toolbar holds the
   views and the menu bar holds the rest. Each of those is the right place to
   put its own thing and the wrong place to look when you do not know which of
   them you want. This is the place you go when you know what you want and not
   where it lives: a chat in any folder, a folder, a file in the one you are in,
   or a command by its name.

   Ctrl+K opens it, except with the cursor in a terminal, where Ctrl+K has meant
   kill-to-end-of-line for forty years and this app is a terminal first.
   Ctrl+Shift+P opens it from anywhere, including there, which is the rule the
   rest of the app's chords already follow.

   Files and the words inside chats are the sections that have to ask main.
   Chats, folders and commands are all in memory, so the list is whole from the
   first keystroke. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardIcon, CopyIcon, DownloadIcon, FileDownIcon, FileIcon, FolderIcon, FolderPlusIcon, FolderTreeIcon,
  GitCompareIcon, GlobeIcon, InfoIcon, MaximizeIcon, MessageSquareIcon, PaletteIcon,
  PlusIcon, SettingsIcon, SquarePenIcon, SquareTerminalIcon, SunMoonIcon, TerminalIcon,
} from 'lucide-react';
import {
  Command, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { runCommand } from '../../app.js';
import { openFolder } from '../../project.js';
import { formatChord, keyOf } from '@/lib/keys';
import { useSettings } from '../useSettings';
import { shortPath, useProject } from '../useProject.js';
import { getRailVersion, grouped, refreshRail, relative, subscribeRail } from './rail-store';

const NO_BODIES = { results: [], titleOnly: [], searched: 0, left: 0 };
/* The commands worth reaching by name. Everything runCommand answers to is not
   the same list: the zoom steps and the folder pickers have chords and buttons
   of their own, and a palette that lists every branch of a switch statement is
   a switch statement with a search box. */
const COMMANDS = [
  { name: 'preview', bind: 'preview', label: 'Preview browser', icon: GlobeIcon },
  { name: 'files', bind: 'files', label: 'Project files', icon: FolderTreeIcon },
  { name: 'changes', bind: 'changes', label: 'Uncommitted changes', icon: GitCompareIcon },
  { name: 'terminal', bind: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { name: 'drawer', bind: 'drawer', label: 'Console and network', icon: SquareTerminalIcon },
  { name: 'previewFull', bind: 'previewFull', label: 'Right pane at full width', icon: MaximizeIcon },
  { name: 'newTerminal', bind: 'newTerminal', label: 'New terminal', icon: PlusIcon },
  { name: 'newChat', bind: 'newChat', label: 'New chat', icon: SquarePenIcon },
  { name: 'newChatNoFolder', bind: 'newChatNoFolder', label: 'New chat without a folder', icon: MessageSquareIcon },
  { name: 'theme', bind: 'theme', label: 'Light or dark', icon: SunMoonIcon },
  { name: 'appearance', bind: 'appearance', label: 'Theme and appearance', icon: PaletteIcon },
  { name: 'settings', bind: 'settings', label: 'Settings', icon: SettingsIcon },
  { name: 'copyMcp', bind: 'copyMcp', label: 'Copy MCP command', icon: ClipboardIcon },
  { name: 'updates', bind: 'updates', label: 'Check for updates', icon: DownloadIcon },
  { name: 'exportChat', bind: 'exportChat', label: 'Export chat', icon: FileDownIcon },
  { name: 'copyLastReply', bind: 'copyLastReply', label: 'Copy last reply', icon: CopyIcon },
  { name: 'about', bind: 'about', label: 'About Conn', icon: InfoIcon },
];

function marked(snippet, q) {
  const at = snippet.toLowerCase().indexOf(q);
  if (at < 0) return snippet;
  return (
    <>
      {snippet.slice(0, at)}
      <span className="font-medium text-foreground">{snippet.slice(at, at + q.length)}</span>
      {snippet.slice(at + q.length)}
    </>
  );
}

const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// A key pressed with the cursor in a terminal belongs to the shell. The
// palette's own chord knows that; this file no longer listens for it.

export default function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState([]);
  const [bodies, setBodies] = useState(NO_BODIES);
  const window_ = useProject();
  const { settings } = useSettings();

  // The rail's store already holds every chat this window knows about, in the
  // order it draws them, with the ones marked done kept apart. Reading it here
  // costs a subscription and keeps one answer to what a chat is called.
  const [, bump] = useState(0);
  useEffect(() => subscribeRail(() => bump(getRailVersion())), []);
  useEffect(() => { if (open) refreshRail(); }, [open]);

  const folders = grouped();
  const chats = folders.flatMap((folder) =>
    [...folder.rows, ...folder.done].map((chat) => ({ chat, folder })));

  const here = new Set((window_.projects || []).map((p) => p.dir));
  const recents = (window_.recents || []).filter((r) => !here.has(r.path)).slice(0, 6);

  /* Files and the words inside chats are what main has to be asked for. The
     wait is the same 80ms the composer's @ menu uses, and the last answer stays
     on screen while the next one is out rather than the list blinking on every
     keystroke. Both go out from the one timer. */
  const live = useRef(0);
  useEffect(() => {
    if (!open || !query.trim()) { setFiles([]); setBodies(NO_BODIES); return undefined; }
    const seq = ++live.current;
    const timer = setTimeout(async () => {
      const text = query.trim();
      const inChats = window.conn.agent.search(text).catch(() => null);
      const res = await window.conn.files.search(text).catch(() => null);
      if (seq === live.current) setFiles((res?.matches || []).slice(0, 8));
      const found = await inChats;
      if (seq === live.current) setBodies(found || NO_BODIES);
    }, 80);
    return () => clearTimeout(timer);
  }, [open, query]);

  const run = useCallback((fn) => { setOpen(false); setQuery(''); fn(); }, []);

  /* cmdk's own filter scores every item against the query and leaves the groups
     where they are, which reads fine until one group is a hundred rows. Typing
     "term" then answers with eight chats that mention terminals and buries the
     command that opens one. So the filtering is done here: each group is cut to
     its own best few, and a group that matched nothing drops out rather than
     pushing the ones that did off the bottom. */
  const q = query.trim().toLowerCase();
  const at = (text) => (text || '').toLowerCase().indexOf(q);
  const hit = (text) => !q || at(text) >= 0;
  const near = (text) => (at(text) < 0 ? 1e6 : at(text));

  // With nothing typed the chats are the recent ones across every folder, not
  // the first few of whichever folder the rail happens to draw first.
  const chatRows = (q
    ? chats.filter(({ chat, folder }) => hit(`${chat.title} ${folder.name}`))
      .sort((a, b) => near(a.chat.title) - near(b.chat.title))
    : [...chats].sort((a, b) => (b.chat.at || 0) - (a.chat.at || 0))
  ).slice(0, 6);

  const shown = new Set(chatRows.map(({ chat }) => chat.id));
  const byId = new Map(chats.map((c) => [c.chat.id, c]));
  const mentionRows = bodies.results
    .filter((r) => !shown.has(r.id))
    .map((r) => ({
      ...(byId.get(r.id) || {
        chat: { id: r.id, project: r.project, provider: r.provider, title: r.title || 'Untitled chat', at: r.at },
        folder: folders.find((f) => f.dir === r.project) || { name: r.project.split(/[/\\]/).filter(Boolean).pop() },
      }),
      snippet: r.snippet,
    }))
    .slice(0, 8);
  const titleOnly = bodies.titleOnly.filter((p) => chats.some(({ chat }) => chat.provider === p.id)).map((p) => p.label);

  const folderRows = (window_.projects || []).filter((p) => hit(`${p.name} ${p.dir}`));
  const recentRows = recents.filter((r) => hit(`${r.name} ${r.path}`));
  const commandRows = COMMANDS.filter((c) => hit(c.label));
  const findFolder = hit('find a folder on this machine');
  const nothing = !chatRows.length && !files.length && !folderRows.length
    && !recentRows.length && !commandRows.length && !findFolder && !mentionRows.length;

  /* The chords live with the rest of the keyboard list. This only has to be
     findable once the window is up, which is when a menu or a key asks for it. */
  useEffect(() => {
    window.connPalette = { open: () => setOpen(true), toggle: () => setOpen((v) => !v) };
    return () => { window.connPalette = null; };
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>Search chats, folders and files, or run a command.</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        {/* Ours, not cmdk's. See the note above the row lists. */}
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search chats, folders and files, or type a command" />
          <CommandList className="max-h-[60vh]">
            {nothing && (
              <div className="py-8 text-center text-muted-foreground text-sm">Nothing matches that.</div>
            )}

            {!!chatRows.length && (
              <CommandGroup heading={q ? 'Chats' : 'Recent chats'}>
                {chatRows.map(({ chat, folder }) => (
                  <CommandItem
                    key={chat.key || chat.id}
                    value={`chat ${chat.key || chat.id}`}
                    onSelect={() => run(() => window.connChat?.open(chat))}>
                    <MessageSquareIcon />
                    <span className="truncate">{chat.title}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      {folder.name} · {relative(chat.at)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!!mentionRows.length && (
              <CommandGroup heading="Chats mentioning">
                {mentionRows.map(({ chat, folder, snippet }) => (
                  <CommandItem
                    key={`mention ${chat.key || chat.id}`}
                    value={`mention ${chat.key || chat.id}`}
                    onSelect={() => run(() => window.connChat?.open(chat))}>
                    <MessageSquareIcon />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{chat.title}</span>
                      <span className="truncate text-muted-foreground text-xs">{marked(snippet, q.replace(/\s+/g, ' '))}</span>
                    </span>
                    <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                      {folder.name} · {relative(chat.at)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {bodies.left > 0 && (
              <div className="px-3 py-1.5 text-muted-foreground text-xs">
                Searched the {bodies.searched} most recent chats. {bodies.left} older {bodies.left === 1 ? 'chat was' : 'chats were'} left out.
              </div>
            )}

            {!!titleOnly.length && (
              <div className="px-3 py-1.5 text-muted-foreground text-xs">
                {listed(titleOnly)} chats match by title only.
              </div>
            )}

            {!!files.length && (
              <CommandGroup heading="Files">
                {files.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={`file ${f.path}`}
                    onSelect={() => run(() => runCommand('openFile', f.path))}>
                    <FileIcon />
                    <span className="truncate">{f.name}</span>
                    {/* Where it is, not what it is called again: a file in the
                        root of the project would otherwise print its own name
                        twice across the row. */}
                    {f.path !== f.name && (
                      <span className="ml-auto shrink-0 truncate text-muted-foreground text-xs">
                        {f.path.slice(0, f.path.length - f.name.length - 1)}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {!!commandRows.length && (
              <CommandGroup heading="Commands">
                {commandRows.map((c) => (
                  <CommandItem
                    key={c.name}
                    value={`command ${c.name}`}
                    onSelect={() => run(() => runCommand(c.name))}>
                    <c.icon />
                    <span>{c.label}</span>
                    {formatChord(keyOf(settings?.keybindings, c.bind)) && (
                      <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                        {formatChord(keyOf(settings?.keybindings, c.bind))}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {(!!folderRows.length || !!recentRows.length || findFolder) && (
              <CommandGroup heading="Folders">
                {folderRows.map((p) => (
                  <CommandItem
                    key={p.dir}
                    value={`folder ${p.dir}`}
                    onSelect={() => run(() => window.conn.project.focus(p.dir))}>
                    <FolderIcon />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto shrink-0 truncate text-muted-foreground text-xs">
                      {shortPath(p.dir, window_.home)}
                    </span>
                  </CommandItem>
                ))}
                {recentRows.map((r) => (
                  <CommandItem
                    key={r.path}
                    value={`recent ${r.path}`}
                    onSelect={() => run(() => openFolder({ dir: r.path }))}>
                    <FolderPlusIcon />
                    <span className="truncate">{r.name}</span>
                    <span className="ml-auto shrink-0 truncate text-muted-foreground text-xs">
                      {shortPath(r.path, window_.home)}
                    </span>
                  </CommandItem>
                ))}
                {findFolder && (
                  <CommandItem value="find-folder" onSelect={() => run(() => openFolder())}>
                    <FolderPlusIcon />
                    <span>Find a folder on this machine…</span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
