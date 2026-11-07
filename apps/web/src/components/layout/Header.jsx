import { Logo } from './Logo.jsx';

export function Header() {
  return (
    <header className="app-header">
      <div className="brand">
        <Logo />
        <span className="brand-name">Hopline</span>
      </div>
      <span className="brand-tag">Peer-to-peer file transfer</span>
    </header>
  );
}
