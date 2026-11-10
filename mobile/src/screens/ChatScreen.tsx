import { useRef } from 'react';
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
import { layout, zinc } from '../theme/zinc';

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
        <Text style={styles.chipRemoveText}>×</Text>
      </Pressable>
    </View>
  );
}

function subtitle(screen: ChatView): { text: string; tone: 'work' | 'wait' | 'plain' } {
  if (screen.line !== '') return { text: screen.line, tone: screen.mark === 'waiting' ? 'wait' : 'work' };
  const parts = [screen.provider, screen.folder === 'Drafts' ? '' : screen.folder].filter((part) => part !== '');
  return { text: parts.join(' · '), tone: 'plain' };
}

export function ChatScreen({ screen }: { screen: ChatView }) {
  const insets = useSafeAreaInsets();
  const list = useRef<{ scrollToEnd: (options?: { animated?: boolean }) => void } | null>(null);
  const stick = useRef(true);
  const under = subtitle(screen);
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <View style={[styles.header, { paddingTop: 8 + insets.top }]}>
        <Pressable onPress={chat.back} accessibilityLabel="Back" hitSlop={8} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {screen.title}
          </Text>
          {under.text === '' ? null : (
            <Text
              style={[styles.subtitle, under.tone === 'work' && styles.work, under.tone === 'wait' && styles.wait]}
              numberOfLines={1}
            >
              {under.text}
            </Text>
          )}
        </View>
      </View>
      <ScrollView
        ref={(node) => {
          list.current = node;
        }}
        style={styles.transcript}
        contentContainerStyle={[styles.transcriptContent, screen.rows.length === 0 && styles.transcriptEmpty]}
        keyboardShouldPersistTaps="handled"
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
            <Text style={styles.emptyNote}>Nothing in this chat yet.</Text>
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
          { paddingBottom: Math.max(layout.composerPad, insets.bottom + 6) },
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
              <Text style={styles.attachGlyph}>＋</Text>
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
              <Text style={styles.sendGlyph}>↑</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: zinc.ground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 9,
    backgroundColor: zinc.chrome,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: zinc.border,
    gap: 10,
  },
  back: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: zinc.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    color: zinc.text,
    fontSize: 22,
    lineHeight: 24,
  },
  headerText: {
    flex: 1,
    gap: 1,
  },
  title: {
    color: zinc.text,
    fontSize: 15,
    fontWeight: '500',
  },
  subtitle: {
    color: zinc.muted,
    fontSize: 12,
  },
  work: {
    color: zinc.working,
  },
  wait: {
    color: zinc.waiting,
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    paddingHorizontal: layout.screen,
    paddingTop: 14,
    paddingBottom: 20,
    gap: layout.gap,
  },
  transcriptEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  empty: {
    gap: 14,
  },
  emptyNote: {
    color: zinc.muted,
    fontSize: 14,
  },
  starters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
    backgroundColor: zinc.chrome,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipPressed: {
    backgroundColor: zinc.secondary,
  },
  chipText: {
    color: zinc.muted,
    fontSize: 12.5,
  },
  composer: {
    paddingHorizontal: 12,
    paddingTop: 6,
    backgroundColor: zinc.ground,
  },
  composerBox: {
    backgroundColor: zinc.input,
    borderColor: zinc.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: layout.composer,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 6,
  },
  composerLine: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  photoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingLeft: 6,
  },
  chipPhoto: {
    width: 52,
    height: 52,
  },
  chipImage: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: zinc.secondary,
  },
  chipRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: zinc.chrome,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipRemoveText: {
    color: zinc.text,
    fontSize: 12,
    lineHeight: 14,
  },
  attach: {
    width: layout.send,
    height: layout.send,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachGlyph: {
    color: zinc.muted,
    fontSize: 22,
    lineHeight: 24,
  },
  input: {
    flex: 1,
    color: zinc.text,
    paddingTop: 5,
    paddingBottom: 5,
    fontSize: 14.5,
    lineHeight: 20,
    maxHeight: 120,
  },
  send: {
    width: layout.send,
    height: layout.send,
    borderRadius: layout.send / 2,
    backgroundColor: zinc.send,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendOff: {
    opacity: 0.3,
  },
  sendGlyph: {
    color: zinc.sendGlyph,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 18,
  },
});
