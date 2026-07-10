// Default dashboard dev URL (dashboard/vite.config.ts). Not user-configurable
// yet — add a settings screen if/when the dashboard's own port becomes
// user-configurable beyond VITE dev defaults.
const DASHBOARD_URL = 'http://localhost:5173';

document.getElementById('open-dashboard')?.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: DASHBOARD_URL });
});
