import { authenticateStaffToken } from './auth.js';

export const authenticateSocket = async (socket, next) => {
  try {
    socket.data.user = await authenticateStaffToken(socket.handshake.auth?.token);
    next();
  } catch (error) {
    next(new Error('Not authorized'));
  }
};

export const registerStaffSocket = (socket) => {
  const user = socket.data.user;
  if (user.role === 'driver') socket.join(`driver:${user._id}`);

  // No caller-supplied driver IDs or status rebroadcasts. HTTP routes validate
  // and persist changes before emitting the authoritative server events.
  socket.on('driver:join', (driverId) => {
    if (user.role === 'driver' && String(driverId) === String(user._id)) {
      socket.join(`driver:${user._id}`);
    }
  });
};
