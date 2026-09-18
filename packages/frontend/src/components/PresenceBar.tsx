import type { ConnectionStatus } from "../lib/wsClient";
import type { RemoteUser } from "../hooks/usePresence";

interface PresenceBarProps {
  roomId: string;
  selfName: string;
  selfColor: string;
  remoteUsers: RemoteUser[];
  status: ConnectionStatus;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "connecting…",
  open: "live",
  reconnecting: "reconnecting…",
  closed: "disconnected",
};

export function PresenceBar({ roomId, selfName, selfColor, remoteUsers, status }: PresenceBarProps) {
  return (
    <header className="presence-bar">
      <div className="presence-left">
        <span className="brand">Parallel</span>
        <code className="room-id">{roomId}</code>
        <button className="copy-link" onClick={() => navigator.clipboard.writeText(window.location.href)}>
          Copy invite link
        </button>
      </div>
      <div className="presence-right">
        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
        <span className="avatar" style={{ backgroundColor: selfColor }} title={`${selfName} (you)`}>
          {selfName.slice(0, 2).toUpperCase()}
        </span>
        {remoteUsers.map((user) => (
          <span
            key={user.userId}
            className="avatar"
            style={{ backgroundColor: user.color }}
            title={user.displayName}
          >
            {user.displayName.slice(0, 2).toUpperCase()}
          </span>
        ))}
      </div>
    </header>
  );
}
