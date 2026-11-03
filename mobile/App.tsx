import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { connectLive, resumeLive } from './src/conn-live';
import { Shell } from './src/screens/Shell';

export default function App() {
  useEffect(() => {
    connectLive();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') resumeLive();
    });
    return () => {
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
