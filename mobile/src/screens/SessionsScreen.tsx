import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chat, type SessionsView } from '../chat';
import { layout, zinc } from '../theme/zinc';

export function SessionsScreen({ screen }: { screen: SessionsView }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop: 12 + insets.top,
          paddingBottom: layout.screen + insets.bottom,
        },
      ]}
    >
      <View style={styles.toolbar}>
        <TextInput
          value={screen.query}
          onChangeText={chat.setQuery}
          placeholder="Search"
          placeholderTextColor={zinc.faint}
          accessibilityLabel="Search"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.search}
        />
        <Pressable
          onPress={chat.newChat}
          accessibilityLabel="New chat"
          style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
        >
          <Text style={styles.newChatText}>+ New chat</Text>
        </Pressable>
      </View>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
      >
        {screen.sections.length === 0 ? (
          <Text style={styles.empty}>No chats</Text>
        ) : (
          screen.sections.map((section) => (
            <View key={section.project} style={styles.section}>
              <Text style={styles.project}>{section.project}</Text>
              <View style={styles.sectionRows}>
                {section.rows.map((row) => (
                  <Pressable
                    key={row.id}
                    onPress={() => chat.open(row.id)}
                    accessibilityLabel={row.title}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <View style={styles.dot} />
                    <View style={styles.rowBody}>
                      <View style={styles.rowTop}>
                        <Text style={styles.title} numberOfLines={1}>
                          {row.title}
                        </Text>
                        <Text style={styles.time}>{row.atLabel}</Text>
                      </View>
                      {row.provider === '' ? null : (
                        <Text style={styles.provider}>{row.provider}</Text>
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: zinc.chrome,
    paddingHorizontal: 12,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  search: {
    flex: 1,
    color: zinc.text,
    backgroundColor: zinc.ground,
    borderColor: zinc.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  newChat: {
    backgroundColor: zinc.secondary,
    borderColor: zinc.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  pressed: {
    opacity: 0.75,
  },
  newChatText: {
    color: zinc.text,
    fontSize: 13,
    fontWeight: '500',
  },
  list: {
    flex: 1,
    marginTop: 6,
  },
  listContent: {
    paddingBottom: layout.screen,
  },
  empty: {
    color: zinc.muted,
    fontSize: 13,
    marginTop: 24,
    paddingHorizontal: 4,
  },
  section: {
    marginTop: 14,
  },
  project: {
    color: zinc.muted,
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 6,
    marginBottom: 2,
  },
  sectionRows: {
    gap: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 6,
  },
  rowPressed: {
    backgroundColor: zinc.secondary,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: zinc.faint,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  title: {
    flex: 1,
    color: zinc.text,
    fontSize: 13.5,
    lineHeight: 18,
  },
  time: {
    color: zinc.faint,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  provider: {
    color: zinc.faint,
    fontSize: 11,
    marginTop: 1,
  },
});
