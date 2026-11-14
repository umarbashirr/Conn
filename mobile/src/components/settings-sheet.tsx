import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { PhoneStatus } from '../conn-live';
import {
  layout,
  radius,
  setAppearance,
  space,
  themed,
  type,
  useAppearance,
  zinc,
  type Appearance,
} from '../theme/zinc';

const CHOICES: readonly { value: Appearance; label: string; icon: 'phone-portrait-outline' | 'sunny-outline' | 'moon-outline' }[] = [
  { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Light', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline' },
];

export function SettingsSheet({
  open,
  phone,
  onClose,
  onScan,
}: {
  open: boolean;
  phone: PhoneStatus;
  onClose: () => void;
  onScan: () => void;
}) {
  const insets = useSafeAreaInsets();
  const appearance = useAppearance();
  const connected = phone === 'bound';
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close settings" />
      <View style={[styles.sheet, { paddingBottom: space.xl + insets.bottom }]}>
        <View style={styles.grabber} />
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">
            Settings
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Done"
            hitSlop={8}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={20} color={zinc.muted} />
          </Pressable>
        </View>

        <Text style={styles.section}>APPEARANCE</Text>
        <View style={styles.segment} accessibilityRole="radiogroup">
          {CHOICES.map((choice) => {
            const on = appearance === choice.value;
            return (
              <Pressable
                key={choice.value}
                onPress={() => setAppearance(choice.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={choice.label}
                style={[styles.option, on && styles.optionOn]}
              >
                <Ionicons name={choice.icon} size={18} color={on ? zinc.text : zinc.muted} />
                <Text style={[styles.optionText, on && styles.optionTextOn]}>{choice.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.section}>COMPUTER</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: connected ? zinc.working : zinc.waiting }]} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{connected ? 'Paired with Conn' : 'Not paired'}</Text>
              <Text style={styles.rowSub}>
                {connected ? 'Chats sync with Conn on your computer.' : 'Scan the code in Conn to pair this phone.'}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={() => {
              onClose();
              onScan();
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, styles.rule, pressed && styles.rowPressed]}
          >
            <Ionicons name="qr-code-outline" size={20} color={zinc.text} />
            <Text style={[styles.rowTitle, styles.grow]}>{connected ? 'Pair again' : 'Scan QR code'}</Text>
            <Ionicons name="chevron-forward" size={18} color={zinc.faint} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = themed(() => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: zinc.scrim,
  },
  sheet: {
    backgroundColor: zinc.ground,
    borderTopLeftRadius: radius.xl + 4,
    borderTopRightRadius: radius.xl + 4,
    borderCurve: 'continuous',
    paddingHorizontal: layout.screen,
    paddingTop: space.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: zinc.border,
    marginBottom: space.md,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
  },
  title: {
    ...type.headline,
    fontSize: 20,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: zinc.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  section: {
    ...type.label,
    marginBottom: space.sm,
    marginLeft: space.xs,
  },
  segment: {
    flexDirection: 'row',
    gap: space.xs,
    padding: space.xs,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    backgroundColor: zinc.secondary,
    marginBottom: space.xl,
  },
  option: {
    flex: 1,
    minHeight: layout.touch + 12,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xxs + 2,
  },
  optionOn: {
    backgroundColor: zinc.raised,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.12)',
  },
  optionText: {
    ...type.caption,
    fontWeight: '600',
    color: zinc.muted,
  },
  optionTextOn: {
    color: zinc.text,
  },
  group: {
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    backgroundColor: zinc.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  rowPressed: {
    backgroundColor: zinc.secondary,
  },
  rule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: zinc.border,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    marginHorizontal: 5,
  },
  rowText: {
    flex: 1,
    gap: space.xxs,
  },
  rowTitle: {
    ...type.body,
    fontWeight: '500',
  },
  rowSub: type.caption,
  grow: {
    flex: 1,
  },
}));
