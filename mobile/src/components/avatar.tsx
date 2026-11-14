import { StyleSheet, Text, View } from 'react-native';
import { providerHue, providerName, radius, themed, zinc } from '../theme/zinc';

// A provider's initial on a tint of its hue. Sized for list rows and headers.
export function Avatar({ provider, size = 40 }: { provider: string; size?: number }) {
  const hue = providerHue(provider);
  const letter = (providerName(provider) || '?').charAt(0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, { width: size, height: size, backgroundColor: `${hue}22` }]}
    >
      <Text style={[styles.letter, { color: hue, fontSize: size * 0.42 }]}>{letter}</Text>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  circle: {
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
  },
  letter: {
    fontWeight: '700',
  },
}));
