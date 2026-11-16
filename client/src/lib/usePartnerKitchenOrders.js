import { useEffect, useRef, useState } from 'react';
import api from '../utils/api';
import { useSocket } from '../contexts/SocketContext';
import { loadPartnerKitchenOrders } from './partnerKitchenData';

export default function usePartnerKitchenOrders(date) {
  const { socket } = useSocket();
  const [state, setState] = useState({date: '', data: null, loading: false, error: ''});
  const refreshRef = useRef(() => {});
  useEffect(() => {
    if (!date) { setState({date: '', data: null, loading: false, error: ''}); return undefined; }
    let alive = true, version = 0;
    const load = async () => {
      const current = ++version;
      setState({date, data: null, loading: true, error: ''});
      try {
        const data = await loadPartnerKitchenOrders(api, date, () => alive && current === version);
        if (alive && current === version) setState({date, data, loading: false, error: ''});
      } catch (error) {
        if (alive && current === version) setState({date, data: null, loading: false, error: error.response?.data?.message || error.message || 'Could not load partner orders.'});
      }
    };
    refreshRef.current = load;
    const changed = event => { if (!event?.date || event.date === date) load(); };
    load(); socket?.on('partner:ordersChanged', changed); socket?.on('connect', load);
    const timer = setInterval(load, 30000);
    return () => {alive = false; clearInterval(timer); socket?.off('partner:ordersChanged', changed); socket?.off('connect', load);};
  }, [date, socket]);
  return {...state, data: state.date === date ? state.data : null, error: state.date === date ? state.error : '', loading: state.date === date ? state.loading : !!date, refresh: () => refreshRef.current()};
}
