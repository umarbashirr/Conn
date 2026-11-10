import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chat, type SessionRow, type SessionsView } from '../chat';
import { adoptTicket, onPhone, type PhoneStatus } from '../conn-live';
import { layout, zinc } from '../theme/zinc';
import { Scan } from './Scan';

function RowMark({ mark }: { mark: SessionRow['mark'] }) {
  switch (mark) {
    case 'working':
      return <ActivityIndicator size="small" color={zinc.working} style={styles.spinner} />;
    case 'waiting':
      return <View style={[styles.dot, styles.waitDot]} />;
    case 'pinned':
      return <View style={styles.pin} />;
    case 'done':
      return <Text style={styles.check}>✓</Text>;
    case 'idle':
      return <View style={styles.dot} />;
    default: {
      const _never: never = mark;
      return _never;
    }
  }
}

function SessionButton({ row, onOpen }: { row: SessionRow; onOpen: (id: SessionRow['id']) => void }) {
  const lineStyle = row.mark === 'waiting' ? styles.waitingLine : styles.workingLine;
  return (
    <Pressable
      onPress={() => onOpen(row.id)}
      accessibilityLabel={row.line === '' ? row.title : `${row.title}, ${row.line}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.mark}>
        <RowMark mark={row.mark} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.title} numberOfLines={1}>
            {row.title}
          </Text>
          <Text style={styles.time}>{row.atLabel}</Text>
        </View>
        {row.line !== '' ? (
          <Text style={lineStyle}>{row.line}</Text>
        ) : row.provider === '' ? null : (
          <Text style={styles.provider}>{row.provider}</Text>
        )}
      </View>
    </Pressable>
  );
}

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
            <View key={section.dir} style={styles.section}>
              <Text style={styles.project}>{section.project}</Text>
              {section.done.length === 0 ? null : (
                <View style={styles.completed}>
                  <Pressable
                    onPress={() => chat.toggleDone(section.dir)}
                    accessibilityLabel={`Completed, ${section.done.length}`}
                    style={styles.completedHead}
                  >
                    <Text style={styles.completedLabel}>
                      {screen.query.trim() !== '' || screen.openDone.includes(section.dir) ? '▾' : '▸'} Completed
                    </Text>
                    <Text style={styles.completedCount}>{section.done.length}</Text>
                  </Pressable>
                  {screen.query.trim() !== '' || screen.openDone.includes(section.dir) ? (
                    <View style={styles.sectionRows}>
                      {section.done.map((row) => (
                        <SessionButton key={row.id} row={row} onOpen={chat.open} />
                      ))}
                    </View>
                  ) : null}
                </View>
              )}
              <View style={styles.sectionRows}>
                {section.rows.map((row) => (
                  <SessionButton key={row.id} row={row} onOpen={chat.open} />
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
  completed: {
    marginBottom: 4,
  },
  completedHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  completedLabel: {
    color: zinc.faint,
    fontSize: 11,
    fontWeight: '500',
  },
  completedCount: {
    marginLeft: 'auto',
    color: zinc.faint,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  mark: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    width: 14,
    height: 14,
  },
  waitDot: {
    backgroundColor: zinc.waiting,
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  pin: {
    width: 8,
    height: 8,
    borderRadius: 1,
    backgroundColor: zinc.muted,
  },
  check: {
    width: 14,
    color: zinc.muted,
    fontSize: 12,
    textAlign: 'center',
  },
  workingLine: {
    color: zinc.working,
    fontSize: 11,
  },
  waitingLine: {
    color: zinc.waiting,
    fontSize: 11,
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
