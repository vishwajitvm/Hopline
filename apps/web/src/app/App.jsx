import { useEffect } from 'react';
import { Header } from '../components/layout/Header.jsx';
import { Footer } from '../components/layout/Footer.jsx';
import { HomeView } from '../components/home/HomeView.jsx';
import { RoomView } from '../components/room/RoomView.jsx';
import { useHoplineSession } from '../hooks/useHoplineSession.js';
import { useInviteLink } from '../hooks/useInviteLink.js';
import { useTransferGuards } from '../hooks/useTransferGuards.js';
import { cleanUpAbandonedStorage } from '../services/storage/sinks.js';
import { Phase } from '../state/session-reducer.js';

export function App() {
  const session = useHoplineSession();
  useInviteLink(session.joinRoom);
  useTransferGuards(session.transfers);

  // Remove files left in browser storage by tabs that were closed mid-transfer.
  useEffect(() => {
    void cleanUpAbandonedStorage();
  }, []);

  const inLobby = session.phase === Phase.IDLE || session.phase === Phase.STARTING;

  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        {inLobby ? (
          <HomeView
            busy={session.phase === Phase.STARTING}
            error={session.error}
            onCreateRoom={session.createRoom}
            onJoinRoom={session.joinRoom}
          />
        ) : (
          <RoomView session={session} />
        )}
      </main>
      <Footer />
    </div>
  );
}
