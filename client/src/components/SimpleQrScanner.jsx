import React, { useRef, useEffect, useState } from 'react';
import Webcam from 'react-webcam';
import jsQR from 'jsqr';

const SimpleQrScanner = ({
  onScan,
  onError,
  constraints,
  scanDelay = 500,
  styles,
  containerStyle,
  videoStyle,
  className
}) => {
  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const lastScanRef = useRef(0);
  const scanIntervalRef = useRef(null);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    let active = true;

    const startScanning = () => {
      if (!webcamRef.current || !canvasRef.current) return;

      setIsScanning(true);
      console.log('[QR Scanner] Starting scan...');

      // Scan at the specified interval
      scanIntervalRef.current = setInterval(() => {
        if (!active || !webcamRef.current) return;

        try {
          const video = webcamRef.current.video;
          if (!video || !video.srcObject) return;

          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');

          // Set canvas dimensions to match video
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;

          if (canvas.width === 0 || canvas.height === 0) return;

          // Draw video frame to canvas
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          // Get image data and scan
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, canvas.width, canvas.height, {
            inversionAttempts: 'dontInvert'
          });

          if (code) {
            const now = Date.now();
            // Rate-limit to prevent duplicate rapid captures
            if (now - lastScanRef.current >= scanDelay) {
              lastScanRef.current = now;
              console.log('[QR Scanner] Detected:', code.data);
              onScan?.([{ rawValue: code.data }]);
            }
          }
        } catch (err) {
          // Silently skip errors - they're expected when no QR code is visible
          console.debug('[QR Scanner] Scan attempt:', err?.message);
        }
      }, 100); // Check every 100ms, but only process if scanDelay has passed
    };

    startScanning();

    return () => {
      active = false;
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
      }
      setIsScanning(false);
    };
  }, [onScan, scanDelay]);

  const videoConstraints = {
    facingMode: 'environment',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    ...(constraints?.video || {})
  };

  const mergedContainerStyle = {
    width: '100%',
    height: '100%',
    ...styles?.container,
    ...containerStyle
  };

  const mergedVideoStyle = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    ...styles?.video,
    ...videoStyle
  };

  return (
    <div className={className} style={mergedContainerStyle}>
      <Webcam
        ref={webcamRef}
        videoConstraints={videoConstraints}
        onUserMediaError={onError}
        style={mergedVideoStyle}
        muted
        playsInline
        autoPlay
      />
      <canvas
        ref={canvasRef}
        style={{ display: 'none' }}
      />
    </div>
  );
};

export default SimpleQrScanner;
