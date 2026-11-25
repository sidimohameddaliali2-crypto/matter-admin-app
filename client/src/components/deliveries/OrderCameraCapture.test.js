import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import OrderCameraCapture from './OrderCameraCapture';

global.IS_REACT_ACT_ENVIRONMENT = true;

test('the camera requests rear-facing video, captures a JPEG and stops the stream', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCapture = jest.fn();
  const track = { stop: jest.fn() };
  const stream = { getTracks: () => [track] };
  const oldMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const getUserMedia = jest.fn().mockResolvedValue(stream);
  const photo = new Blob(['photo'], { type: 'image/jpeg' });
  const drawImage = jest.fn();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage });
  jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(photo));
  jest.useFakeTimers();

  try {
    await act(async () => root.render(<OrderCameraCapture label="Outside the box" onCapture={onCapture} onClose={jest.fn()} />));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: expect.objectContaining({ facingMode: { ideal: 'environment' } }) });
    const video = document.body.querySelector('video');
    expect(video.srcObject).toBe(stream);
    Object.defineProperties(video, { videoWidth: { value: 1600 }, videoHeight: { value: 1200 } });
    await act(async () => video.dispatchEvent(new Event('canplay', { bubbles: true })));
    const capture = [...document.body.querySelectorAll('button')].find(button => button.textContent === 'Take photo');
    expect(capture.disabled).toBe(false);
    await act(async () => capture.click());
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 960);
    expect(document.body.querySelector('.order-camera-shutter')).not.toBeNull();
    expect(onCapture).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(240));
    expect(onCapture).toHaveBeenCalledWith(photo);
  } finally {
    await act(async () => root.unmount());
    jest.useRealTimers();
    container.remove();
    if (oldMediaDevices) Object.defineProperty(navigator, 'mediaDevices', oldMediaDevices);
    else delete navigator.mediaDevices;
    jest.restoreAllMocks();
  }
  expect(track.stop).toHaveBeenCalled();
});

test('the localhost sample can be captured and closed without requesting a camera', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCapture = jest.fn();
  const oldMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const oldFetch = global.fetch;
  const photo = new Blob(['sample'], { type: 'image/jpeg' });
  const getUserMedia = jest.fn();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  localStorage.setItem('user', JSON.stringify({ email: 'kitchen@yellowblock.test' }));
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => 'image/jpeg' }, blob: async () => photo });
  jest.useFakeTimers();

  try {
    await act(async () => root.render(<OrderCameraCapture label="Inside the box" onCapture={onCapture} onClose={jest.fn()} />));
    expect(getUserMedia).not.toHaveBeenCalled();
    const preview = document.body.querySelector('img[alt="Sample snack order in an open packing box"]');
    await act(async () => preview.dispatchEvent(new Event('load')));
    const capture = [...document.body.querySelectorAll('button')].find(button => button.textContent === 'Take demo photo');
    await act(async () => capture.click());
    await act(async () => jest.advanceTimersByTime(240));
    expect(onCapture).toHaveBeenCalledWith(photo);
  } finally {
    await act(async () => root.unmount());
    jest.useRealTimers();
    container.remove();
    localStorage.removeItem('user');
    global.fetch = oldFetch;
    if (oldMediaDevices) Object.defineProperty(navigator, 'mediaDevices', oldMediaDevices);
    else delete navigator.mediaDevices;
  }
});
