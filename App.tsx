import * as React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { GameProvider } from './src/game/GameProvider';
import { GameScreen } from './src/game/GameScreen';
import { createNativeServices } from './src/game/nativeServices';

/**
 * IRON VERGE — React Native entry point.
 * In dev/CI, replace createNativeServices() with createMockServices() to run the
 * entire game without StoreKit, Play Billing, ads SDKs or a backend.
 */
export default function App(): React.ReactElement {
  const services = React.useMemo(() => createNativeServices({
    baseUrl: 'https://api.ironverge.game',
    playerId: 'player-local', // replace with the authenticated player id
    authTokenProvider: async () => null,  // inject your auth SDK here
  }), []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GameProvider services={services}>
        <GameScreen />
      </GameProvider>
    </GestureHandlerRootView>
  );
}
