const BACKEND_URL = process.env.TRACKER_BACKEND_URL || 'https://activitytracker-gvnr.onrender.com';
const API_SECRET  = process.env.TRACKER_API_SECRET  || '71ddb21c90749e011a1fa72d77da08ce6ef4f7227dc3996a27a540a7a0b31b6f';

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// status 0 = could not reach the server (offline, DNS, timeout)
async function request(path, { method = 'GET', body, token, secret, timeoutMs = 75_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (secret) headers['x-api-secret'] = API_SECRET;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(BACKEND_URL + path, {
      method, headers, signal: ctrl.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

module.exports = { request, ApiError, BACKEND_URL };
