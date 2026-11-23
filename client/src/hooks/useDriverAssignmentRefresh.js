import {useEffect} from 'react';
import {useDispatch} from 'react-redux';
import {useSocket} from '../contexts/SocketContext';
import {fetchDriverDeliveries} from '../store/slices/driverMobileSlice';
// Refetch the authenticated driver's own feed rather than trusting a broadcast
// payload, including when work is reassigned away. Offline queues stay intact.
export default function useDriverAssignmentRefresh(){
 const dispatch=useDispatch(),{socket}=useSocket();
 useEffect(()=>{
  let timer;
  const refresh=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(navigator.onLine!==false)dispatch(fetchDriverDeliveries());},350);};
  const visible=()=>{if(document.visibilityState==='visible')refresh();};
  const events=['delivery:created','delivery:updated','delivery:statusUpdate','deliveries:deleted','connect'];
  events.forEach(name=>socket?.on(name,refresh));window.addEventListener('online',refresh);document.addEventListener('visibilitychange',visible);
  return()=>{clearTimeout(timer);events.forEach(name=>socket?.off(name,refresh));window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',visible);};
 },[socket,dispatch]);
}
