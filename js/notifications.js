(() => {
  const STORAGE_KEY = 'aiNotifications';
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  window.addAINotification = (title, message, type = 'info') => {
    const items = read();
    items.unshift({ id: Date.now(), title, message, type, time: new Date().toLocaleString(), read: false });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 30)));
  };
  window.getAINotifications = read;
  window.markAINotificationsRead = () => {
    const items = read().map(item => ({ ...item, read: true }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  };
})();
