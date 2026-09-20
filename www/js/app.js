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

  const add = (title, message, type = 'info') => {
    const items = read();
    items.unshift({
      id: Date.now(),
      title,
      message,
      type,
      time: new Date().toLocaleString(),
      read: false
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 30)));
  };

  const markRead = () => {
    const items = read().map(item => ({ ...item, read: true }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  };

  const api = {
    read,
    add,
    markRead,
    get: read,
    set: add
  };

  window.aiAppNotifications = api;
  window.addAINotification = add;
  window.getAINotifications = read;
  window.markAINotificationsRead = markRead;
})();
