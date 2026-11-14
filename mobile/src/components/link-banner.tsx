import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { onLink, type LinkState } from '../conn-live';
import { radius, space, themed, type, zinc } from '../theme/zinc';

// Shown only while a paired phone has lost Conn. A phone that was never
// paired gets the empty state on the chat list instead.
export function LinkBanner({ paired }: { paired: boolean }) {
  const [link, setLink] = useState<LinkState>({ online: true, reason: '' });
  useEffect(() => onLink(setLink), []);
  if (!paired || link.online || link.reason === '') return null;
  const retrying = link.reason.startsWith('Reconnecting');
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      {retrying ? (
        <ActivityIndicator size="small" color={zinc.waiting} />
      ) : (
        <Ionicons name="cloud-offline-outline" size={17} color={zinc.waiting} />
      )}
      <Text style={styles.text}>{link.reason}</Text>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: zinc.waitingFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.waitingBorder,
  },
  text: {
    ...type.subhead,
    flex: 1,
    color: zinc.text,
  },
}));
