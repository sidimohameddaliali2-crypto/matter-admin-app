import { attachRequestReference } from './requestReference';

function clientFixture() {
  const handlers = {};
  attachRequestReference({
    interceptors: {
      response: {
        use(success, failure) {
          handlers.success = success;
          handlers.failure = failure;
        },
      },
    },
  });
  return handlers;
}

test('reference survives success and error without modifying bodies or response identity', async () => {
  const id = '00112233-4455-6677-8899-aabbccddeeff';
  const response = { data: { success: true }, headers: { 'x-request-id': id }, status: 200 };
  const handlers = clientFixture();
  expect(handlers.success(response)).toBe(response);
  expect(response.requestId).toBe(id);
  expect(response.data).toEqual({ success: true });
  const failure = new Error('Failed');
  failure.response = { headers: { 'x-request-id': id }, status: 503 };
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(handlers.failure(failure)).rejects.toBe(failure);
    expect(failure.requestId).toBe(id);
    expect(log).toHaveBeenCalledWith('Request failed', { requestId: id, status: 503 });
  } finally {
    log.mockRestore();
  }
});

test('missing and malformed reference headers leave normal error handling usable', async () => {
  const handlers = clientFixture();
  const error = new Error('offline');
  await expect(handlers.failure(error)).rejects.toBe(error);
  expect(error.requestId).toBeUndefined();
  expect(
    handlers.success({ headers: { 'x-request-id': 'private-invalid-value' }, data: {} }).requestId,
  ).toBeUndefined();
});
