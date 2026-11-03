import type { ReactElement } from 'react';
import { useScreen } from '../chat';
import { ChatScreen } from './ChatScreen';
import { SessionsScreen } from './SessionsScreen';

export function Shell(): ReactElement {
  const screen = useScreen();
  switch (screen.name) {
    case 'sessions':
      return <SessionsScreen screen={screen} />;
    case 'chat':
      return <ChatScreen screen={screen} />;
    default: {
      const _never: never = screen;
      return _never;
    }
  }
}
