(() => {
  const isNative = window.location.protocol === 'capacitor:' || (window.location.protocol === 'http:' && window.location.hostname === 'localhost');
  const API_BASE = isNative ? 'http://10.0.2.2:8000' : (window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : window.location.origin);

  const publicPages = new Set(['login.html']);
  const page = window.location.pathname.split('/').pop() || 'index.html';
  if (publicPages.has(page)) return;
  const token = localStorage.getItem('authToken');
  if (!token) return window.location.replace('login.html');
  fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    .then(response => {
      if (!response.ok) throw new Error('Session expired');
    })
    .catch(() => {
      localStorage.removeItem('authToken');
      localStorage.removeItem('currentUser');
      window.location.replace('login.html');
    });
})();
