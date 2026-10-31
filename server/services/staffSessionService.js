import jwt from 'jsonwebtoken';

// Owner (2026-10-29): Keep long-running driver sessions, but make password
// changes revoke existing staff credentials. Missing versions are legacy zero.
export const staffSessionVersion = (user) => user.sessionVersion ?? 0;

export const generateStaffToken = (user) => jwt.sign({
  id: String(user._id),
  sessionVersion: staffSessionVersion(user)
}, process.env.JWT_SECRET, { algorithm: 'HS256' });

export const assertCurrentStaffSession = (claims, user) => {
  const version = claims.sessionVersion === undefined ? 0 : claims.sessionVersion;
  if (!Number.isSafeInteger(version) || version < 0 || version !== staffSessionVersion(user)) {
    throw new Error('Not authorized, session revoked');
  }
};

export const staffSocketRoom = (userId) => `staff:${String(userId)}`;

export const disconnectStaffSessions = (io, userId) => {
  if (!io) return;
  const sessions = io.in(staffSocketRoom(userId));
  sessions.emit('auth:revoked');
  sessions.disconnectSockets(true);
};
