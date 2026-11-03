import { useEffect, useState } from 'react';
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
import { adoptTicket, onPhone, type PhoneStatus } from '../conn-live';
import { layout, zinc } from '../theme/zinc';
import { Scan } from './Scan';

function statusLabel(status: PhoneStatus): string {
  switch (status) {
    case 'bound':
      return 'Connected';
    case 'empty':
      return 'Not connected';
    case 'pending':
      return 'Checking…';
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function statusHue(status: PhoneStatus): string {
  switch (status) {
    case 'bound':
      return zinc.working;
    case 'empty':
      return zinc.waiting;
    case 'pending':
      return zinc.faint;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function actionLabel(status: PhoneStatus): string {
  switch (status) {
    case 'bound':
      return 'Scan again';
    case 'empty':
    case 'pending':
      return 'Connect';
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

export function SessionsScreen({ screen }: { screen: SessionsView }) {
  const insets = useSafeAreaInsets();
  const [phone, setPhone] = useState<PhoneStatus>('pending');
  const [scanning, setScanning] = useState(false);

  useEffect(() => onPhone(setPhone), []);

  if (scanning) {
    return (
      <Scan
        onCancel={() => setScanning(false)}
        onText={async (raw) => {
          const ok = await adoptTicket(raw);
          if (ok) setScanning(false);
          return ok;
        }}
      />
    );
  }

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
      <View style={styles.header}>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusHue(phone) }]} />
          <Text style={styles.statusText}>{statusLabel(phone)}</Text>
        </View>
        <Pressable
          onPress={() => setScanning(true)}
          accessibilityLabel={actionLabel(phone)}
          style={({ pressed }) => [styles.newChat, pressed && styles.pressed]}
        >
          <Text style={styles.newChatText}>{actionLabel(phone)}</Text>
        </Pressable>
      </View>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    color: zinc.muted,
    fontSize: 12.5,
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
