import { useEffect, useRef } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chat, ChatItemView, type ChatView } from '../chat';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../components/avatar';
import { useKeyboardOpen } from '../components/keyboard';
import { LinkBanner } from '../components/link-banner';
import { layout, providerName, radius, space, type, zinc, themed } from '../theme/zinc';

function PhotoChip({
  photo,
  onRemove,
}: {
  photo: ChatView['photos'][number];
  onRemove: () => void;
}) {
  return (
    <View style={styles.chipPhoto}>
      <Image source={{ uri: photo.uri }} accessibilityLabel="Attached photo" style={styles.chipImage} />
      <Pressable onPress={onRemove} accessibilityLabel="Remove photo" hitSlop={6} style={styles.chipRemove}>
        <Ionicons name="close" size={13} color={zinc.text} />
      </Pressable>
    </View>
  );
}

function subtitle(screen: ChatView): { text: string; tone: 'work' | 'wait' | 'plain' } {
  if (screen.line !== '') return { text: screen.line, tone: screen.mark === 'waiting' ? 'wait' : 'work' };
  const parts = [providerName(screen.provider), screen.folder === 'Drafts' ? '' : screen.folder].filter((part) => part !== '');
  return { text: parts.join(' · '), tone: 'plain' };
}

export function ChatScreen({ screen }: { screen: ChatView }) {
  const insets = useSafeAreaInsets();
  const list = useRef<{ scrollToEnd: (options?: { animated?: boolean }) => void } | null>(null);
  const stick = useRef(true);
  const under = subtitle(screen);
  const keyboard = useKeyboardOpen();

  // Opening the keyboard is a sign the person is about to reply, so the
  // newest message should sit just above the composer, not behind the keys.
  useEffect(() => {
    if (!keyboard) return;
    stick.current = true;
    const t = setTimeout(() => list.current?.scrollToEnd({ animated: true }), Platform.OS === 'ios' ? 0 : 60);
    return () => clearTimeout(t);
  }, [keyboard]);

  return (
    // Android draws edge to edge here, so the system no longer shrinks the
    // window for the keyboard. Both platforms pad the screen themselves.
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={[styles.header, { paddingTop: space.xs + insets.top }]}>
        <Pressable
          onPress={chat.back}
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          hitSlop={8}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={26} color={zinc.text} />
        </Pressable>
        <Avatar provider={screen.provider || 'claude'} size={34} />
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {screen.title}
          </Text>
          {under.text === '' ? null : (
            <View style={styles.subRow}>
              {under.tone === 'plain' ? null : (
                <View style={[styles.subDot, { backgroundColor: under.tone === 'wait' ? zinc.waiting : zinc.working }]} />
              )}
              <Text
              style={[styles.subtitle, under.tone === 'work' && styles.work, under.tone === 'wait' && styles.wait]}
              numberOfLines={1}
            >
              {under.text}
              </Text>
            </View>
          )}
        </View>
      </View>
      <LinkBanner paired />
      <ScrollView
        ref={(node) => {
          list.current = node;
        }}
        style={styles.transcript}
        contentContainerStyle={[styles.transcriptContent, screen.rows.length === 0 && styles.transcriptEmpty]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        onScroll={(event) => {
          const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
          stick.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
        }}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (stick.current) list.current?.scrollToEnd({ animated: false });
        }}
      >
        {screen.rows.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="sparkles-outline" size={24} color={zinc.muted} />
            </View>
            <Text style={styles.emptyTitle}>What should the agent do?</Text>
            <Text style={styles.emptyNote}>It works in {screen.folder === 'Drafts' ? 'your current folder' : screen.folder} on your computer.</Text>
            {screen.starters.length === 0 ? null : (
              <View style={styles.starters}>
                {screen.starters.map((text) => (
                  <Pressable
                    key={text}
                    onPress={() => chat.setDraft(text)}
                    style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                  >
                    <Text style={styles.chipText}>{text}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        ) : (
          screen.rows.map((row) => <ChatItemView key={row.id} row={row} />)
        )}
      </ScrollView>
      <View
        style={[
          styles.composer,
          { paddingBottom: keyboard ? space.sm : Math.max(layout.composerPad, insets.bottom + 6) },
        ]}
      >
        <View style={styles.composerBox}>
          {screen.photos.length === 0 ? null : (
            <View style={styles.photoRow}>
              {screen.photos.map((photo, index) => (
                <PhotoChip
                  key={`${photo.uri}:${index}`}
                  photo={photo}
                  onRemove={() => chat.dropPhoto(index)}
                />
              ))}
            </View>
          )}
          <View style={styles.composerLine}>
            <Pressable
              onPress={() => chat.attach('library')}
              disabled={!screen.canAttach}
              accessibilityLabel="Add photo"
              accessibilityState={{ disabled: !screen.canAttach }}
              hitSlop={6}
              style={[styles.attach, !screen.canAttach && styles.sendOff]}
            >
              <Ionicons name="add" size={24} color={zinc.muted} />
            </Pressable>
            <TextInput
              value={screen.draft}
              onChangeText={chat.setDraft}
              placeholder="Message"
              placeholderTextColor={zinc.faint}
              accessibilityLabel="Message"
              multiline
              style={styles.input}
            />
            <Pressable
              onPress={chat.send}
              disabled={!screen.canSend}
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !screen.canSend }}
              hitSlop={6}
              style={[styles.send, !screen.canSend && styles.sendOff]}
            >
              <Ionicons name="arrow-up" size={19} color={zinc.sendGlyph} />
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = themed(() => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: zinc.ground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xxs,
    paddingRight: layout.screen,
    paddingBottom: space.sm + 2,
    backgroundColor: zinc.chrome,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: zinc.border,
    gap: space.sm,
  },
  back: {
    width: 36,
    marginRight: -space.xs,
    height: layout.touch,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  headerText: {
    flex: 1,
    gap: space.xxs,
  },
  title: type.headline,
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
  },
  subDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
  },
  subtitle: type.caption,
  work: {
    color: zinc.working,
  },
  wait: {
    color: zinc.waiting,
    fontWeight: '600',
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    paddingHorizontal: layout.screen,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    gap: space.md,
  },
  transcriptEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: radius.full,
    backgroundColor: zinc.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  emptyTitle: type.headline,
  emptyNote: {
    ...type.subhead,
    textAlign: 'center',
  },
  starters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.md,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
    backgroundColor: zinc.raised,
    borderRadius: radius.full,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm,
  },
  chipPressed: {
    backgroundColor: zinc.secondary,
  },
  chipText: {
    ...type.subhead,
    color: zinc.text,
  },
  composer: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: zinc.ground,
  },
  composerBox: {
    backgroundColor: zinc.raised,
    borderColor: zinc.border,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.06)',
    borderRadius: layout.composer,
    borderCurve: 'continuous',
    paddingLeft: space.xs,
    paddingRight: space.xs + 2,
    paddingVertical: space.xs + 2,
    gap: space.sm,
  },
  composerLine: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.xs,
  },
  photoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingLeft: space.sm,
    paddingTop: space.xs,
  },
  chipPhoto: {
    width: 56,
    height: 56,
  },
  chipImage: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: zinc.secondary,
  },
  chipRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: zinc.secondary,
    borderWidth: 1.5,
    borderColor: zinc.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attach: {
    width: layout.send,
    height: layout.send,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    ...type.body,
    flex: 1,
    paddingTop: space.xs + 3,
    paddingBottom: space.xs + 3,
    maxHeight: 140,
  },
  send: {
    width: layout.send,
    height: layout.send,
    borderRadius: radius.full,
    backgroundColor: zinc.send,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendOff: {
    opacity: 0.3,
  },
}));
