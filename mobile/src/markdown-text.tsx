import type { ReactElement, ReactNode } from 'react';
import { Platform, Text } from 'react-native';
import Markdown, { MarkdownIt, type RenderRules } from 'react-native-markdown-display';
import multimdTable from 'markdown-it-multimd-table';
import { currentScheme, zinc } from './theme/zinc';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

type StrikeToken = { markup: string; content: string };

type StrikeState = {
  pos: number;
  src: string;
  push: (type: string, tag: string, nesting: number) => StrikeToken;
};

type StrikeRule = (state: StrikeState, silent: boolean) => boolean;

type StrikeParser = {
  inline: {
    ruler: {
      before: (before: string, name: string, fn: StrikeRule) => void;
    };
  };
};

function strikethrough(md: StrikeParser): void {
  md.inline.ruler.before('emphasis', 'strike', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 126 || state.src.charCodeAt(start + 1) !== 126) return false;
    const end = state.src.indexOf('~~', start + 2);
    if (end < 0) return false;
    const inner = state.src.slice(start + 2, end);
    if (inner.trim() === '' || inner.includes('\n')) return false;
    if (!silent) {
      const open = state.push('s_open', 's', 1);
      open.markup = '~~';
      const text = state.push('text', '', 0);
      text.content = inner;
      const close = state.push('s_close', 's', -1);
      close.markup = '~~';
    }
    state.pos = end + 2;
    return true;
  });
}

const markdownIt = MarkdownIt({
  linkify: true,
  typographer: false,
}).use(strikethrough).use(multimdTable);

type Tone = 'prose' | 'faint';

function palette(tone: Tone) {
  const color = tone === 'faint' ? zinc.faint : zinc.text;
  const fontSize = tone === 'faint' ? 13.5 : 16;
  const lineHeight = tone === 'faint' ? 19 : 23;
  const text = { color, fontSize, lineHeight };
  return {
    body: text,
    text,
    textgroup: text,
    paragraph: {
      marginTop: 0,
      marginBottom: tone === 'faint' ? 4 : 8,
    },
    heading1: { ...text, fontSize: 21, lineHeight: 27, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
    heading2: { ...text, fontSize: 18, lineHeight: 24, fontWeight: '600' as const, marginTop: 8, marginBottom: 4 },
    heading3: { ...text, fontSize: 16, lineHeight: 22, fontWeight: '600' as const, marginTop: 6, marginBottom: 2 },
    heading4: { ...text, fontWeight: '600' as const },
    heading5: text,
    heading6: text,
    strong: { fontWeight: '700' as const },
    em: { fontStyle: 'italic' as const },
    s: { textDecorationLine: 'line-through' as const },
    link: { color: zinc.working, textDecorationLine: 'underline' as const },
    blockquote: {
      backgroundColor: 'transparent',
      borderColor: zinc.border,
      borderLeftWidth: 2,
      marginLeft: 0,
      paddingHorizontal: 10,
    },
    hr: { backgroundColor: zinc.border, height: 1, marginVertical: 8 },
    bullet_list_icon: { color, marginLeft: 2, marginRight: 8, fontSize, lineHeight },
    ordered_list_icon: { color, marginLeft: 2, marginRight: 8, fontSize, lineHeight },
    list_item: text,
    code_inline: {
      fontFamily: mono,
      backgroundColor: zinc.secondary,
      color: zinc.text,
      borderWidth: 0,
      padding: 0,
      paddingHorizontal: 4,
      borderRadius: 4,
      fontSize: fontSize - 1,
    },
    fence: {
      fontFamily: mono,
      backgroundColor: zinc.raised,
      color: zinc.text,
      borderWidth: 0,
      borderRadius: 10,
      padding: 12,
      fontSize: 13.5,
      lineHeight: 20,
    },
    code_block: {
      fontFamily: mono,
      backgroundColor: zinc.raised,
      color: zinc.text,
      borderWidth: 0,
      borderRadius: 10,
      padding: 12,
      fontSize: 13.5,
      lineHeight: 20,
    },
    table: { borderColor: zinc.border, borderWidth: 1 },
    tr: { borderColor: zinc.border },
    th: { padding: 6, fontWeight: '600' as const },
    td: { padding: 6 },
  };
}

const built: Partial<Record<string, ReturnType<typeof palette>>> = {};

function styleFor(tone: Tone, scheme: string): ReturnType<typeof palette> {
  const key = `${scheme}:${tone}`;
  return (built[key] ??= palette(tone));
}

function fenceBody(content: string): string {
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}

const rules: RenderRules = {
  textgroup: (node, children, _parent, styles) => (
    <Text key={node.key} selectable style={styles.textgroup}>
      {children as ReactNode}
    </Text>
  ),
  fence: (node, _children, _parent, styles, inherited) => (
    <Text key={node.key} selectable style={[inherited, styles.fence]}>
      {fenceBody(node.content)}
    </Text>
  ),
  code_block: (node, _children, _parent, styles, inherited) => (
    <Text key={node.key} selectable style={[inherited, styles.code_block]}>
      {fenceBody(node.content)}
    </Text>
  ),
};

export function MarkdownText({ text, tone = 'prose' }: { text: string; tone?: Tone }): ReactElement {
  const scheme = currentScheme();
  return (
    <Markdown markdownit={markdownIt} style={styleFor(tone, scheme)} rules={rules}>
      {text}
    </Markdown>
  );
}
