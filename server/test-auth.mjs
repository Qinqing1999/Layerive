// Shared by the server test suite: every /api route (except /api/health) now
// requires a session token, so tests log in against their freshly spawned
// server before exercising the routes.
export async function login(base) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  if (!response.ok) throw new Error(`test login failed with ${response.status}`);
  const payload = await response.json();
  if (!payload.token) throw new Error('test login did not return a token');
  return payload.token;
}

export const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });
