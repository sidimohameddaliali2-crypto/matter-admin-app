import { authenticateStaffToken } from './auth.js';
import { staffSocketRoom } from '../services/staffSessionService.js';

export const authenticateSocket = async (socket, next) => {
  try {
    socket.data.user = await authenticateStaffToken(socket.handshake.auth?.token);
    next();
  } catch (error) {
    next(new Error('Not authorized'));
  }
};

export const registerStaffSocket = async (socket, { recheckIntervalMs = 30_000 } = {}) => {
  const user = socket.data.user;
  try {
    await socket.join(staffSocketRoom(user._id));
    // Close the race where a password changed after handshake validation but
    // before this socket joined the room used for revocation broadcasts.
    await authenticateStaffToken(socket.handshake.auth?.token);
    if (socket.connected === false) return;
    if (user.role === 'driver') await socket.join(`driver:${user._id}`);
    if (socket.connected === false) return;
  } catch {
    socket.emit('auth:revoked');
    socket.disconnect(true);
    return;
  }

  // The database remains authoritative if a cross-worker revocation broadcast
  // is missed (for example, while Redis is unavailable). Bound stale socket
  // access to this interval instead of leaving it open indefinitely.
  let checking = false;
  const recheck = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      await authenticateStaffToken(socket.handshake.auth?.token);
    } catch {
      socket.emit('auth:revoked');
      socket.disconnect(true);
    } finally {
      checking = false;
    }
  }, recheckIntervalMs);
  recheck.unref();
  socket.on('disconnect', () => clearInterval(recheck));

  // No caller-supplied driver IDs or status rebroadcasts. HTTP routes validate
  // and persist changes before emitting the authoritative server events.
  socket.on('driver:join', (driverId) => {
    if (user.role === 'driver' && String(driverId) === String(user._id)) {
      socket.join(`driver:${user._id}`);
    }
  });
};
