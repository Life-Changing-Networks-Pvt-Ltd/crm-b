import { syncAllActiveVendors } from './indiamartService.js';

let syncIntervalHandle = null;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const startIndiaMartSyncRuntime = () => {
  if (syncIntervalHandle) {
    return;
  }

  console.log('[IndiaMART Worker] Lead auto-sync runtime started (Interval: 5 mins)');

  // Initial trigger after 30 seconds of server boot
  setTimeout(async () => {
    try {
      const stats = await syncAllActiveVendors();
      if (stats.totalCreated > 0) {
        console.log(`[IndiaMART Worker] Initial sync completed: ${stats.totalCreated} leads ingested.`);
      }
    } catch (e) {
      // Non-blocking log
    }
  }, 30000);

  syncIntervalHandle = setInterval(async () => {
    try {
      const stats = await syncAllActiveVendors();
      if (stats.totalCreated > 0) {
        console.log(`[IndiaMART Worker] Periodic sync completed: ${stats.totalCreated} new leads.`);
      }
    } catch (err) {
      console.error('[IndiaMART Worker] Sync iteration failed:', err.message);
    }
  }, SYNC_INTERVAL_MS);
};

export const stopIndiaMartSyncRuntime = () => {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
    console.log('[IndiaMART Worker] Lead auto-sync runtime stopped');
  }
};
