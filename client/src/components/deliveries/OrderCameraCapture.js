import React, { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from '@mui/material';
import { Camera, Image, X } from 'lucide-react';
import './OrderCameraCapture.css';

const stop = stream => stream?.getTracks().forEach(track => track.stop());
const shutterDuration = 240;

function localDemoPhoto() {
  if (!['[::1]', '127.0.0.1', 'localhost'].includes(window.location.hostname)) return '';
  try {
    const { email } = JSON.parse(localStorage.getItem('user')) || {};
    return ['kitchen@yellowblock.test', 'driver@yellowblock.test'].includes(email) ? '/yellowblock-camera-demo.jpg' : '';
  } catch {
    return '';
  }
}

function cameraError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
    return 'Allow camera access in your phone or browser settings, then try again.';
  }
  if (error.name === 'NotFoundError') return 'This device has no available camera.';
  return 'Could not start the camera. Close any other app using it and try again.';
}

export default function OrderCameraCapture({ label, onCapture, onClose }) {
  const titleId = useId();
  const videoRef = useRef(null);
  const liveRef = useRef(false);
  const shutterTimer = useRef(null);
  const [demoPhoto] = useState(localDemoPhoto);
  const [demoMode, setDemoMode] = useState(Boolean(demoPhoto));
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [showShutter, setShowShutter] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    liveRef.current = true;
    let cancelled = false;
    let stream;
    let video;
    const start = async () => {
      if (!window.isSecureContext && !navigator.mediaDevices?.getUserMedia) {
        setError('Open the app over HTTPS to use the phone camera.');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot open the camera. Open the app in your phone’s browser.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
        });
        video = videoRef.current;
        if (cancelled || !video) {
          stop(stream);
          return;
        }
        video.srcObject = stream;
        await video.play();
      } catch (reason) {
        if (!cancelled) {
          stop(stream);
          setReady(false);
          setError(cameraError(reason));
        }
      }
    };
    if (!demoMode) Promise.resolve().then(() => { if (!cancelled) start(); });
    return () => {
      cancelled = true;
      liveRef.current = false;
      clearTimeout(shutterTimer.current);
      stop(stream);
      if (video && video.srcObject === stream) video.srcObject = null;
    };
  }, [attempt, demoMode]);

  const finishCapture = (photo) => {
    if (!liveRef.current) return;
    const finish = () => {
      if (!liveRef.current) return;
      setShowShutter(false);
      setCapturing(false);
      onCapture(photo);
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) finish();
    else {
      setShowShutter(true);
      shutterTimer.current = setTimeout(finish, shutterDuration);
    }
  };

  const fail = () => {
    if (!liveRef.current) return;
    setCapturing(false);
    setError('Could not take the photo. Try again.');
  };

  const takePhoto = () => {
    const video = videoRef.current;
    if (capturing || !ready) return;
    setCapturing(true);
    if (demoMode) {
      fetch(demoPhoto).then(response => {
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Demo photo unavailable');
        return response.blob();
      }).then(finishCapture).catch(fail);
      return;
    }
    if (!video?.videoWidth || !video.videoHeight) {
      fail();
      return;
    }
    try {
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(photo => {
        if (!liveRef.current) return;
        if (photo) finishCapture(photo);
        else fail();
      }, 'image/jpeg', 0.82);
    } catch {
      fail();
    }
  };

  const switchMode = () => {
    setError('');
    setReady(false);
    setDemoMode(value => !value);
  };

  const shutterLabel = demoMode ? 'Take demo photo' : 'Take photo';

  return (
    <Dialog open fullScreen onClose={onClose} aria-labelledby={titleId} PaperProps={{ sx: { backgroundColor: '#181311', color: '#fff' } }}>
      <div className="flex h-full min-h-0 flex-col" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-2">
          <div className="min-w-0">
            <h2 id={titleId} className="font-semibold">{label}</h2>
            {demoMode && <span className="mt-1 inline-block rounded-full bg-[#fbeae2] px-2.5 py-0.5 text-xs font-semibold text-[#822813]">Demo photo</span>}
          </div>
          <button type="button" aria-label="Close camera" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/10">
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 items-center justify-center overflow-hidden bg-black">
          {demoMode ? (
            <img key={attempt} src={demoPhoto} alt="Sample snack order in an open packing box"
              className="absolute inset-0 h-full w-full object-contain" onLoad={() => setReady(true)}
              onError={() => setError('The demo photo could not load. Try again or use the live camera.')} />
          ) : (
            <video ref={videoRef} autoPlay muted playsInline aria-label="Live camera preview"
              className="absolute inset-0 h-full w-full object-contain" onCanPlay={() => setReady(true)} />
          )}
          {!error && ready && <div className="order-viewfinder" aria-hidden="true" />}
          {showShutter && <div className="order-camera-shutter" aria-hidden="true" />}
          {error && <p role="alert" className="relative mx-4 max-w-sm rounded-xl bg-[#181311] p-4 text-center text-sm text-white">{error}</p>}
          {!error && !ready && <p role="status" className="relative p-4 text-sm text-white">{demoMode ? 'Loading demo photo…' : 'Opening camera…'}</p>}
        </div>
        <footer className="mx-auto flex w-full max-w-sm flex-col items-center gap-1 p-3">
          <button type="button" className="group flex min-h-16 min-w-32 flex-col items-center gap-2 rounded-xl px-3 py-1 text-sm font-semibold text-white disabled:opacity-45"
            disabled={capturing || (!error && !ready)} onClick={error ? () => { setError(''); setReady(false); setAttempt(value => value + 1); } : takePhoto}>
            <span className="order-shutter-button" aria-hidden="true"><Camera size={24} /></span>
            {error ? (demoMode ? 'Retry demo photo' : 'Try camera again') : capturing ? 'Taking photo…' : shutterLabel}
          </button>
          {demoPhoto && (
            <button type="button" onClick={switchMode} disabled={capturing} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-[#f6c2ad] hover:bg-white/10 disabled:opacity-45">
              {demoMode ? <Camera size={16} aria-hidden="true" /> : <Image size={16} aria-hidden="true" />}
              {demoMode ? 'Use live camera' : 'Use demo photo'}
            </button>
          )}
        </footer>
      </div>
    </Dialog>
  );
}
