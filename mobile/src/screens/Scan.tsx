import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState, type ReactElement } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, zinc } from '../theme/zinc';

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
        setError('Invalid connection code. Scan or paste the code from Settings > Phone in Conn.');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <View style={[styles.header, { paddingTop: 8 + insets.top }]}>
        {onCancel ? (
          <Pressable onPress={onCancel} accessibilityLabel="Back" hitSlop={8} style={styles.back}>
            <Text style={styles.backText}>‹ Chats</Text>
          </Pressable>
        ) : null}
        <Text style={styles.title} numberOfLines={1}>
          Phone link
        </Text>
      </View>

      <View style={[styles.body, { paddingBottom: Math.max(layout.screen, insets.bottom + 12) }]}>
        <Text style={styles.hint}>
          Open Customize › Phone in Conn on your computer and scan the QR code or paste the code below.
        </Text>

        <View style={styles.cameraFrame}>
          {permission?.granted ? (
            <CameraView
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (typeof data === 'string' && data !== '') void submit(data, true);
              }}
              style={styles.camera}
            />
          ) : (
            <View style={styles.permissionBox}>
              <Text style={styles.permissionText}>
                Camera access lets Conn scan the QR code from your computer.
              </Text>
              <Pressable
                onPress={() => void requestPermission()}
                accessibilityLabel="Allow camera"
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              >
                <Text style={styles.buttonText}>Allow camera</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={styles.pasteSection}>
          <Text style={styles.label}>Connection code</Text>
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
              placeholder="conn://gate?..."
              placeholderTextColor={zinc.faint}
              accessibilityLabel="Connection code"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <Pressable
              onPress={() => void submit(draft, false)}
              disabled={busy || draft.trim() === ''}
              accessibilityLabel="Connect"
              accessibilityState={{ disabled: busy || draft.trim() === '' }}
              style={({ pressed }) => [
                styles.connectButton,
                (busy || draft.trim() === '') && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.connectText}>Connect</Text>
            </Pressable>
          </View>
          {error === '' ? null : <Text style={styles.error}>{error}</Text>}
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
  body: {
    flex: 1,
    paddingHorizontal: layout.screen,
    paddingTop: 14,
    gap: 16,
  },
  hint: {
    color: zinc.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  cameraFrame: {
    height: 240,
    borderRadius: layout.bubble,
    overflow: 'hidden',
    backgroundColor: zinc.chrome,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: zinc.border,
  },
  camera: {
    flex: 1,
  },
  permissionBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    gap: 12,
  },
  permissionText: {
    color: zinc.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  button: {
    backgroundColor: zinc.secondary,
    borderColor: zinc.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  buttonText: {
    color: zinc.text,
    fontSize: 13,
    fontWeight: '500',
  },
  pasteSection: {
    gap: 8,
  },
  label: {
    color: zinc.muted,
    fontSize: 12,
    fontWeight: '500',
  },
  pasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    color: zinc.text,
    backgroundColor: zinc.input,
    borderColor: zinc.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12.5,
    fontFamily: monoFont,
  },
  connectButton: {
    backgroundColor: zinc.send,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  connectText: {
    color: zinc.sendGlyph,
    fontSize: 13,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.35,
  },
  pressed: {
    opacity: 0.75,
  },
  error: {
    color: zinc.danger,
    fontSize: 12.5,
    lineHeight: 17,
  },
});
