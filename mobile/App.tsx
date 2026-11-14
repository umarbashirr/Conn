import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Linking, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { adoptTicket, connectLive, resumeLive } from './src/conn-live';
import { Shell } from './src/screens/Shell';
import { useScheme, zinc } from './src/theme/zinc';

export default function App() {
  // Style sheets rebuild per scheme, so the tree renders again when it flips.
  const scheme = useScheme();
  useEffect(() => {
    connectLive();
    void Linking.getInitialURL().then((url) => {
      if (url) void adoptTicket(url);
    });
    const links = Linking.addEventListener('url', ({ url }) => {
      void adoptTicket(url);
    });
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') resumeLive();
    });
    return () => {
      links.remove();
      sub.remove();
    };
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
      <View style={{ flex: 1, backgroundColor: zinc.ground }}>
        <Shell />
      </View>
    </SafeAreaProvider>
  );
}
