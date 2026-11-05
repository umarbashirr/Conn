import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { adoptTicket, connectLive, resumeLive } from './src/conn-live';
import { Shell } from './src/screens/Shell';

export default function App() {
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
      <StatusBar style="light" />
      <Shell />
    </SafeAreaProvider>
  );
}
