import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
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
import { Ionicons } from '@expo/vector-icons';
import { layout, radius, space, type, zinc, themed } from '../theme/zinc';

type ScanProps = {
  onText: (raw: string) => Promise<boolean>;
  onCancel?: () => void;
};

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function Scan({ onText, onCancel }: ScanProps): ReactElement {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Camera frames arrive continuously; hold the last rejected payload so one
  // bad QR in view does not re-run adoptTicket on every frame.
  const busyRef = useRef(false);
  const rejectedRef = useRef('');

  async function submit(raw: string, fromCamera: boolean): Promise<void> {
    if (busyRef.current) return;
    if (fromCamera && raw === rejectedRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const ok = await onText(raw);
      if (!ok) {
        if (fromCamera) rejectedRef.current = raw;
        setError('Invalid connection code. Scan or paste the code from Customize › Phone in Conn.');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior="padding"
    >
      <View style={[styles.header, { paddingTop: space.xs + insets.top }]}>
        {onCancel ? (
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="Back to chats"
            hitSlop={8}
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}
          >
            <Ionicons name="chevron-back" size={24} color={zinc.text} />
          </Pressable>
        ) : null}
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          Connect to Conn
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.body, { paddingBottom: space.xl + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.steps}>
          {[
            'Open Conn on your computer.',
            'Go to Customize › Phone.',
            'Point your camera at the QR code.',
          ].map((step, i) => (
            <View key={step} style={styles.step}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>

        <View style={styles.cameraFrame}>
          {permission?.granted ? (
            <>
              <CameraView
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => {
                  if (typeof data === 'string' && data !== '') void submit(data, true);
                }}
                style={styles.camera}
              />
              <View pointerEvents="none" style={styles.guides}>
                <View style={[styles.corner, styles.tl]} />
                <View style={[styles.corner, styles.tr]} />
                <View style={[styles.corner, styles.bl]} />
                <View style={[styles.corner, styles.br]} />
              </View>
            </>
          ) : (
            <View style={styles.permissionBox}>
              <View style={styles.permissionIcon}>
                <Ionicons name="camera-outline" size={26} color={zinc.muted} />
              </View>
              <Text style={styles.permissionText}>
                Allow the camera to scan the QR code shown in Conn on your computer.
              </Text>
              <Pressable
                onPress={() => void requestPermission()}
                accessibilityRole="button"
                accessibilityLabel="Allow camera"
                style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
              >
                <Text style={styles.primaryText}>Allow camera</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={styles.pasteSection}>
          <View style={styles.divider}>
            <View style={styles.rule} />
            <Text style={styles.label}>or paste a code</Text>
            <View style={styles.rule} />
          </View>
          <View style={styles.pasteRow}>
            <TextInput
              value={draft}
              onChangeText={(next) => {
                setDraft(next);
                if (error !== '') setError('');
              }}
              onSubmitEditing={() => {
                if (draft.trim() !== '') void submit(draft, false);
              }}
              placeholder="conn://gate?…"
              placeholderTextColor={zinc.faint}
              accessibilityLabel="Connection code"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              style={[styles.input, error !== '' && styles.inputError]}
            />
            <Pressable
              onPress={() => void submit(draft, false)}
              disabled={busy || draft.trim() === ''}
              accessibilityRole="button"
              accessibilityLabel="Connect"
              accessibilityState={{ disabled: busy || draft.trim() === '', busy }}
              style={({ pressed }) => [
                styles.connectButton,
                (busy || draft.trim() === '') && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={zinc.sendGlyph} />
              ) : (
                <Text style={styles.connectText}>Connect</Text>
              )}
            </Pressable>
          </View>
          {error === '' ? null : (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle" size={16} color={zinc.danger} />
              <Text style={styles.error}>{error}</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const CORNER = 28;

const styles = themed(() => StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: zinc.ground,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.xs,
    paddingRight: layout.screen,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: zinc.border,
    gap: space.xs,
  },
  back: {
    width: layout.touch,
    height: layout.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...type.headline,
    flex: 1,
    paddingLeft: space.sm,
    minHeight: layout.touch,
    textAlignVertical: 'center',
    lineHeight: layout.touch,
  },
  scroll: {
    flex: 1,
  },
  body: {
    paddingHorizontal: layout.screen,
    paddingTop: space.xl,
    gap: space.xl,
  },
  steps: {
    gap: space.md,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: zinc.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: {
    ...type.label,
    color: zinc.text,
  },
  stepText: {
    ...type.body,
    flex: 1,
  },
  cameraFrame: {
    aspectRatio: 1,
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center',
    borderRadius: radius.lg + 6,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: zinc.raised,
  },
  camera: {
    flex: 1,
  },
  guides: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    margin: space.xl,
  },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: zinc.text,
  },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: radius.md },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: radius.md },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: radius.md },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: radius.md },
  permissionBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.md,
  },
  permissionIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: zinc.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionText: {
    ...type.subhead,
    textAlign: 'center',
  },
  primary: {
    minHeight: layout.touch,
    paddingHorizontal: space.xl,
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
  pasteSection: {
    gap: space.md,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  rule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: zinc.border,
  },
  label: type.caption,
  pasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  input: {
    flex: 1,
    minHeight: layout.touch,
    color: zinc.text,
    backgroundColor: zinc.secondary,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: radius.md,
    borderCurve: 'continuous',
    paddingHorizontal: space.md,
    fontSize: 14,
    fontFamily: monoFont,
  },
  inputError: {
    borderColor: zinc.danger,
  },
  connectButton: {
    minHeight: layout.touch,
    minWidth: 96,
    backgroundColor: zinc.send,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectText: {
    ...type.headline,
    fontSize: 15,
    color: zinc.sendGlyph,
  },
  disabled: {
    opacity: 0.35,
  },
  pressed: {
    opacity: 0.7,
  },
  errorRow: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'flex-start',
  },
  error: {
    ...type.subhead,
    flex: 1,
    color: zinc.danger,
  },
}));
