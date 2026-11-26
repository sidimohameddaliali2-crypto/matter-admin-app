import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../../utils/api';
import YellowblockOrderWorkflow from './YellowblockOrderWorkflow';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('./OrderCameraCapture', () => ({ __esModule: true, default: ({ label, onCapture }) => (
  <button type="button" onClick={() => onCapture(new Blob(['camera photo'], { type: 'image/jpeg' }))}>Capture {label}</button>
) }));
global.IS_REACT_ACT_ENVIRONMENT = true;

test('the kitchen can acknowledge an order and complete preparation with the two required photos', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = text => [...container.querySelectorAll('button')].find(element => element.textContent === text);
  const openCamera = label => container.querySelector(`button[aria-label="Open camera: ${label}"]`);
  const response = data => ({ data: { data } });
  const inPreparation = { status: 'in_preparation', at: '2026-11-23T10:00:00Z', actor: 'Kitchen Staff' };

  api.get.mockResolvedValue(response({
    customerName: 'Sample Customer', emirate: 'Dubai', items: [{ title: 'Snack Box', quantity: 2 }],
    status: 'pending', timeline: [], courier: 'Snack Out', canDispatch: true,
    couriers: [{ id: 'Snack Out', name: 'Snack Out' }],
  }));
  api.post.mockResolvedValueOnce(response({ status: 'in_preparation', timeline: [inPreparation] }));
  api.post.mockResolvedValueOnce(response({
    status: 'prepared', hasPhotos: true,
    timeline: [inPreparation, { ...inPreparation, status: 'prepared', at: '2026-11-23T10:05:00Z' }],
  }));

  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => 'blob:camera-photo');
  URL.revokeObjectURL = jest.fn();

  try {
    await act(async () => root.render(<YellowblockOrderWorkflow id="123" kitchen />));
    expect(api.get).toHaveBeenCalledWith('/yellowblock/kitchen/orders/123', expect.anything());
    expect(container.textContent).toContain('Sample Customer');
    expect(container.textContent).toContain('Dubai');
    expect(container.textContent).toContain('Snack Out');
    expect(container.textContent).not.toContain('Order timeline');
    expect(container.querySelector('select')).toBeNull();
    await act(async () => button('Acknowledge').click());
    expect(api.post).toHaveBeenCalledWith('/yellowblock/kitchen/orders/123/status/in_preparation', undefined);
    expect(button('Done').disabled).toBe(true);

    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(openCamera('Order inside the box').disabled).toBe(true);
    for (const [index, label] of ['Order displayed outside the box', 'Order inside the box'].entries()) {
      await act(async () => openCamera(label).click());
      await act(async () => button(`Capture ${label}`).click());
      expect(container.querySelector(`button[aria-label="Retake photo: ${label}"] img`)).not.toBeNull();
      expect(button('Done').disabled).toBe(index === 0);
    }
    await act(async () => button('Done').click());
    const [path, body] = api.post.mock.calls[1];
    expect(path).toBe('/yellowblock/kitchen/orders/123/status/prepared');
    expect(body.get('displayPhoto').name).toBe('displayPhoto.jpg');
    expect(body.get('boxedPhoto').name).toBe('boxedPhoto.jpg');
    expect(container.querySelector('[role="status"]').textContent).toContain('Order prepared');
    expect(container.textContent).not.toContain('Order timeline');
    expect(button('View preparation photos')).toBeUndefined();
    expect(button('Mark driver collected')).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test('Order details retain the timeline and only allow assignment in the Order page', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  api.get.mockResolvedValue({ data: { data: {
    status: 'prepared', timeline: [], courier: '', courierId: '', canDispatch: true,
    couriers: [{ id: 'Ali', name: 'Ali' }],
  } } });

  try {
    await act(async () => root.render(<YellowblockOrderWorkflow id="123" />));
    expect(container.textContent).toContain('Order timeline');
    expect(container.querySelector('select').textContent).toContain('Ali');
    await act(async () => root.render(<YellowblockOrderWorkflow id="123" allowAssignment={false} />));
    expect(container.textContent).toContain('Order timeline');
    expect(container.querySelector('select')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
