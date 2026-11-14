import { useEffect, useState, type ComponentProps } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import { chat, type SessionRow, type SessionsView } from '../chat';
import { adoptTicket, onLink, onPhone, type LinkState, type PhoneStatus } from '../conn-live';
import { Avatar } from '../components/avatar';
import { LinkBanner } from '../components/link-banner';
import { SettingsSheet } from '../components/settings-sheet';
import { layout, providerName, radius, space, themed, type, zinc } from '../theme/zinc';
import { Scan } from './Scan';

type IconName = ComponentProps<typeof Ionicons>['name'];

// The status a row's avatar carries in its corner. Idle and done carry none.
function Badge({ mark }: { mark: SessionRow['mark'] }) {
  switch (mark) {
    case 'working':
      return (
        <View style={[styles.badge, { backgroundColor: zinc.working }]}>
          <Ionicons name="ellipsis-horizontal" size={10} color="#FFFFFF" />
        </View>
      );
    case 'waiting':
      return (
        <View style={[styles.badge, { backgroundColor: zinc.waiting }]}>
          <Ionicons name="hand-left" size={9} color="#FFFFFF" />
        </View>
      );
    case 'pinned':
      return (
        <View style={[styles.badge, { backgroundColor: zinc.secondary }]}>
          <Ionicons name="pin" size={9} color={zinc.muted} />
        </View>
      );
    case 'done':
    case 'idle':
      return null;
    default: {
      const _never: never = mark;
      return _never;
    }
  }
}

function SessionButton({
  row,
  first,
  onOpen,
}: {
  row: SessionRow;
  first: boolean;
  onOpen: (id: SessionRow['id']) => void;
}) {
  const done = row.mark === 'done';
  const name = providerName(row.provider);
  return (
    <Pressable
      onPress={() => onOpen(row.id)}
      accessibilityRole="button"
      accessibilityLabel={[row.title, row.line, name].filter((part) => part !== '').join(', ')}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.avatarSlot, done && styles.dim]}>
        <Avatar provider={row.provider} size={40} />
        <Badge mark={row.mark} />
      </View>
      <View style={[styles.rowBody, !first && styles.rowRule]}>
        <View style={styles.rowTop}>
          <Text style={[styles.title, done && styles.titleDone]} numberOfLines={1}>
            {row.title}
          </Text>
          <Text style={styles.time}>{row.atLabel}</Text>
        </View>
        {row.line !== '' ? (
          <Text style={row.mark === 'waiting' ? styles.waitingLine : styles.workingLine} numberOfLines={1}>
            {row.line}
          </Text>
        ) : (
          <Text style={styles.provider} numberOfLines={1}>
            {done ? `${name} · Completed` : name}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function IconButton({
  icon,
  label,
  filled,
  onPress,
}: {
  icon: IconName;
  label: string;
  filled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, filled && styles.iconFilled, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={filled ? 21 : 20} color={filled ? zinc.sendGlyph : zinc.text} />
    </Pressable>
  );
}

function Empty({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: IconName;
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={30} color={zinc.text} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      <Pressable
        onPress={onAction}
        accessibilityRole="button"
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>{action}</Text>
      </Pressable>
    </View>
  );
}

export function SessionsScreen({ screen }: { screen: SessionsView }) {
  const insets = useSafeAreaInsets();
  const [phone, setPhone] = useState<PhoneStatus>('pending');
  const [scanning, setScanning] = useState(false);
  const [settings, setSettings] = useState(false);

  const [link, setLink] = useState<LinkState>({ online: false, reason: '' });
  useEffect(() => onPhone(setPhone), []);
  useEffect(() => onLink(setLink), []);

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

  const searching = screen.query.trim() !== '';
  const connected = phone === 'bound';
  const offline = connected && !link.online && link.reason !== '';
  const total = screen.sections.reduce((n, s) => n + s.rows.length, 0);

  return (
    <View style={[styles.screen, { paddingTop: space.sm + insets.top }]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.heading} accessibilityRole="header">
            Chats
          </Text>
          <View style={styles.status}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: offline || !connected ? (phone === 'pending' ? zinc.faint : zinc.waiting) : link.online ? zinc.working : zinc.faint },
              ]}
            />
            <Text style={styles.statusText}>
              {!connected
                ? phone === 'pending' ? 'Connecting…' : 'Not paired'
                : offline ? 'Offline'
                : !link.online ? 'Connecting…'
                : total === 1 ? '1 open chat' : `${total} open chats`}
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          <IconButton icon="settings-outline" label="Settings" onPress={() => setSettings(true)} />
          <IconButton icon="add" label="New chat" filled onPress={chat.newChat} />
        </View>
      </View>

      <LinkBanner paired={connected} />

      <View style={styles.search}>
        <Ionicons name="search" size={17} color={zinc.faint} />
        <TextInput
          value={screen.query}
          onChangeText={chat.setQuery}
          placeholder="Search"
          placeholderTextColor={zinc.faint}
          accessibilityLabel="Search chats"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />
        {searching ? (
          <Pressable onPress={() => chat.setQuery('')} accessibilityLabel="Clear search" hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={zinc.faint} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={[styles.listContent, { paddingBottom: space.xxl + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {screen.sections.length === 0 ? (
          phone === 'pending' || (connected && !link.online && !offline) ? (
            <ActivityIndicator color={zinc.faint} style={styles.checking} />
          ) : searching ? (
            <View style={styles.noMatch}>
              <Ionicons name="search" size={22} color={zinc.faint} />
              <Text style={styles.noMatchText}>No chats match “{screen.query.trim()}”</Text>
            </View>
          ) : offline ? null : connected ? (
            <Empty
              icon="chatbubbles-outline"
              title="No chats yet"
              body="Start a chat here, or open one in Conn on your computer and it shows up here."
              action="Start a chat"
              onAction={chat.newChat}
            />
          ) : (
            <Empty
              icon="qr-code-outline"
              title="Pair with your computer"
              body="Open Conn on your computer, go to Customize › Phone, and scan the code."
              action="Scan QR code"
              onAction={() => setScanning(true)}
            />
          )
        ) : (
          screen.sections.map((section) => {
            const showDone = searching || screen.openDone.includes(section.dir);
            const count = section.rows.length;
            return (
              <View key={section.dir} style={styles.section}>
                <View style={styles.sectionHead}>
                  <Text style={styles.project} numberOfLines={1}>
                    {section.project}
                  </Text>
                  {count > 0 ? <Text style={styles.sectionCount}>{count}</Text> : null}
                </View>
                <View style={styles.group}>
                  {section.rows.map((row, i) => (
                    <SessionButton key={row.id} row={row} first={i === 0} onOpen={chat.open} />
                  ))}
                  {section.done.length === 0 ? null : (
                    <Pressable
                      onPress={() => chat.toggleDone(section.dir)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: showDone }}
                      accessibilityLabel={`Completed, ${section.done.length}`}
                      style={({ pressed }) => [styles.doneRow, pressed && styles.rowPressed]}
                    >
                      <View style={[styles.doneInner, count > 0 && styles.rowRule]}>
                        <Ionicons name="checkmark-done" size={17} color={zinc.faint} />
                        <Text style={styles.doneLabel}>
                          {showDone ? 'Hide completed' : `Show ${section.done.length} completed`}
                        </Text>
                        <Ionicons name={showDone ? 'chevron-up' : 'chevron-down'} size={16} color={zinc.faint} />
                      </View>
                    </Pressable>
                  )}
                  {showDone
                    ? section.done.map((row) => (
                        <SessionButton key={row.id} row={row} first={false} onOpen={chat.open} />
                      ))
                    : null}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <SettingsSheet
        open={settings}
        phone={phone}
        onClose={() => setSettings(false)}
        onScan={() => setScanning(true)}
      />
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: zinc.ground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: layout.screen,
    paddingTop: space.sm,
  },
  heading: type.title,
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    marginTop: space.xxs,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
  },
  statusText: type.subhead,
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    paddingTop: space.xxs,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: zinc.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconFilled: {
    backgroundColor: zinc.send,
  },
  pressed: {
    opacity: 0.7,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 42,
    marginHorizontal: layout.screen,
    marginTop: space.lg,
    paddingHorizontal: space.md,
    backgroundColor: zinc.secondary,
    borderRadius: radius.md + 2,
    borderCurve: 'continuous',
  },
  searchInput: {
    ...type.body,
    flex: 1,
    paddingVertical: space.sm,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: layout.screen,
  },
  checking: {
    marginTop: space.xxl * 2,
  },
  noMatch: {
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xxl * 1.5,
  },
  noMatchText: type.subhead,
  empty: {
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xxl * 2,
    paddingHorizontal: space.lg,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.xl + 2,
    borderCurve: 'continuous',
    backgroundColor: zinc.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  emptyTitle: {
    ...type.headline,
    fontSize: 20,
    lineHeight: 26,
  },
  emptyBody: {
    ...type.subhead,
    textAlign: 'center',
    maxWidth: 300,
  },
  primary: {
    marginTop: space.lg,
    minHeight: 48,
    paddingHorizontal: space.xl + 4,
    borderRadius: radius.full,
    backgroundColor: zinc.send,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    ...type.headline,
    fontSize: 16,
    color: zinc.sendGlyph,
  },
  section: {
    marginTop: space.xl,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
    paddingHorizontal: space.xs,
    marginBottom: space.sm,
  },
  project: {
    ...type.headline,
    fontSize: 15,
    flexShrink: 1,
  },
  sectionCount: type.caption,
  group: {
    backgroundColor: zinc.raised,
    borderRadius: radius.lg + 2,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingLeft: space.md,
    minHeight: 68,
  },
  rowPressed: {
    backgroundColor: zinc.secondary,
  },
  rowRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: zinc.border,
  },
  avatarSlot: {
    width: 40,
    marginRight: space.md,
    justifyContent: 'center',
  },
  dim: {
    opacity: 0.55,
  },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: 10,
    width: 17,
    height: 17,
    borderRadius: radius.full,
    borderWidth: 2,
    borderColor: zinc.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 3,
    paddingVertical: space.md,
    paddingRight: space.md,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  title: {
    ...type.row,
    flex: 1,
  },
  titleDone: {
    color: zinc.muted,
    fontWeight: '500',
  },
  time: {
    ...type.caption,
    fontVariant: ['tabular-nums'],
  },
  provider: {
    ...type.subhead,
    fontSize: 13.5,
  },
  workingLine: {
    ...type.subhead,
    fontSize: 13.5,
    color: zinc.working,
    fontWeight: '500',
  },
  waitingLine: {
    ...type.subhead,
    fontSize: 13.5,
    color: zinc.waiting,
    fontWeight: '600',
  },
  doneRow: {
    paddingLeft: space.md,
  },
  doneInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 48,
    paddingLeft: space.md - 2,
    paddingRight: space.md,
  },
  doneLabel: {
    ...type.subhead,
    flex: 1,
    fontWeight: '500',
  },
}));
