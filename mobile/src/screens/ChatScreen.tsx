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

export function ChatScreen({ screen }: { screen: ChatView }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <View style={[styles.header, { paddingTop: 8 + insets.top }]}>
        <Pressable onPress={chat.back} accessibilityLabel="Back" hitSlop={8} style={styles.back}>
          <Text style={styles.backText}>‹ Chats</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {screen.title}
        </Text>
      </View>
      <ScrollView
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        keyboardShouldPersistTaps="handled"
      >
        {screen.rows.map((row) => (
          <ChatItemView key={row.id} row={row} />
        ))}
      </ScrollView>
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
    paddingVertical: 4,
    paddingRight: 4,
  },
  backText: {
    color: zinc.muted,
    fontSize: 13.5,
  },
  title: {
    flex: 1,
    color: zinc.text,
    fontSize: 14,
    fontWeight: '500',
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    paddingHorizontal: layout.screen,
    paddingVertical: 14,
    gap: layout.gap,
  },
  starters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: layout.screen,
    paddingBottom: 10,
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
