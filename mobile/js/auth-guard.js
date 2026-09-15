(() => {
  const publicPages = new Set(['login.html']);
  const page = window.location.pathname.split('/').pop() || 'index.html';
  if (publicPages.has(page)) return;
  const token = localStorage.getItem('authToken');
  if (!token) return window.location.replace('login.html');
  fetch('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
    .then(response => {
      if (!response.ok) throw new Error('Session expired');
    })
    .catch(() => {
      localStorage.removeItem('authToken');
      localStorage.removeItem('currentUser');
      window.location.replace('login.html');
    });
})();
