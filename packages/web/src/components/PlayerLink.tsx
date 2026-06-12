import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function PlayerLink({ profileId, children, className }: {
  profileId: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={`/players/${profileId}`}
      className={`player-link ${className ?? ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}