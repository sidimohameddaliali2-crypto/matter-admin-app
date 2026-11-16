// Read only a server-generated opaque reference. No URL, body, session or identity
// is sent to a telemetry service or persisted in browser storage.
export function attachRequestReference(client) {
  const reference = (response) => {
    const value = response?.headers?.['x-request-id'];
    return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
  };
  client.interceptors.response.use(
    (response) => {
      response.requestId = reference(response);
      return response;
    },
    (error) => {
      error.requestId = reference(error.response);
      if (error.requestId)
        console.error('Request failed', {
          requestId: error.requestId,
          status: error.response.status,
        });
      return Promise.reject(error);
    },
  );
}
