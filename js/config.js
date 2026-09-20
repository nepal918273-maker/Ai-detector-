const isNative = window.location.protocol === 'capacitor:' || (window.location.protocol === 'http:' && window.location.hostname === 'localhost');
const API_BASE = isNative ? 'http://10.0.2.2:8000' : (window.location.protocol === 'file:' ? 'http://127.0.0.1:8000' : window.location.origin);

window.APP_CONFIG = {
    isNative,
    API_BASE
};
