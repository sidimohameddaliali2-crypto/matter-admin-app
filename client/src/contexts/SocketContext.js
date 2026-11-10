import React, { createContext, useContext, useEffect, useState } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import io from 'socket.io-client';
import { logout } from '../store/slices/authSlice';

const SocketContext = createContext();

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};

// Only opens a connection for a logged-in staff user (SocketProvider wraps
// the whole app, including public pages like /menu-select/:token and
// /join/:token, which have no reason to hold a live socket open). Reacts to
// state.auth.token rather than reading localStorage once on mount, so a
// socket opens right after login (no page refresh needed) and closes right
// on logout — previously the one-time read meant a user who logged in
// without reloading kept an unauthenticated socket open for the rest of
// their session.
export const SocketProvider = ({ children }) => {
  const dispatch = useDispatch();
  const store = useStore();
  const token = useSelector((state) => state.auth.token);
  const [socket, setSocket] = useState(null);
  const [onlineDrivers, setOnlineDrivers] = useState([]);

  useEffect(() => {
    if (!token) {
      setSocket(null);
      return undefined;
    }

    const defaultSocketUrl = ['localhost', '127.0.0.1'].includes(window.location.hostname)
      ? 'http://localhost:5000'
      : window.location.origin;
    const newSocket = io(process.env.REACT_APP_SOCKET_URL || defaultSocketUrl, {
      auth: { token }
    });

    setSocket(newSocket);

    // Clear staff credentials only. Unsynced driver work stays in IndexedDB
    // so it can be retried after the driver signs in with the new password.
    const handleSessionRevoked = () => {
      if (store.getState().auth.token === token) dispatch(logout());
    };
    const handleConnectError = (error) => {
      if (error.message === 'Not authorized') handleSessionRevoked();
    };
    newSocket.on('auth:revoked', handleSessionRevoked);
    newSocket.on('connect_error', handleConnectError);

    newSocket.on('drivers:statusUpdate', (data) => {
      setOnlineDrivers(data.onlineDrivers);
    });

    newSocket.on('delivery:statusUpdate', (data) => {
      // Handle real-time delivery updates
      console.log('Delivery update:', data);
    });

    return () => {
      newSocket.off('auth:revoked', handleSessionRevoked);
      newSocket.off('connect_error', handleConnectError);
      newSocket.close();
    };
  }, [dispatch, store, token]);

  const value = {
    socket,
    onlineDrivers
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};
