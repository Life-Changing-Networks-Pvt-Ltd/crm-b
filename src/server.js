import app from './app.js';
import connectDB from './config/db.js';
import seedAdmin from './seed/adminSeed.js';
import http from 'http';
import { Server } from 'socket.io';
import { configureRealtime } from './services/realtimeService.js';
import { warmCacheConnection } from './services/cacheService.js';

const PORT = process.env.PORT || 8080;

const startBackgroundRuntimes = async () => {
  await Promise.all([
    import('./modules/email-marketing/services/emailQueueService.js')
      .then(({ startEmailMarketingRuntime }) => startEmailMarketingRuntime())
      .catch((error) => {
        console.error(
          '[Email Marketing] Background runtime could not start:',
          error.message,
        );
      }),
    import('./modules/email-marketing/services/automationQueueService.js')
      .then(({ startEmailMarketingAutomationRuntime }) => (
        startEmailMarketingAutomationRuntime()
      ))
      .catch((error) => {
        console.error(
          '[Email Marketing] Automation runtime could not start:',
          error.message,
        );
      }),
    import('./services/followUpReminderService.js')
      .then(({ startFollowUpReminderRuntime }) => startFollowUpReminderRuntime())
      .catch((error) => {
        console.error('[FollowUpScheduler] Runtime could not start:', error.message);
      }),
    import('./services/indiamartSyncScheduler.js')
      .then(({ startIndiaMartSyncRuntime }) => startIndiaMartSyncRuntime())
      .catch((error) => {
        console.error('[IndiaMART Worker] Runtime could not start:', error.message);
      }),
  ]);
};

const startServer = async () => {
  try {
    const cacheWarmup = warmCacheConnection().catch(() => false);
    await connectDB();

    // Seed admin user
    await seedAdmin();

    const server = http.createServer(app);
    const io = new Server(server, {
      serveClient: false,
      perMessageDeflate: false,
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    const userSockets = new Map();
    configureRealtime(io, userSockets);

    io.on('connection', (socket) => {
      socket.on('register', (userId) => {
        if (!userId) return;
        const key = String(userId);
        const previousKey = socket.data.crmUserId;
        if (previousKey && previousKey !== key) {
          const previousSockets = userSockets.get(previousKey);
          previousSockets?.delete(socket.id);
          if (previousSockets?.size === 0) userSockets.delete(previousKey);
        }
        const sockets = userSockets.get(key) || new Set();
        sockets.add(socket.id);
        userSockets.set(key, sockets);
        socket.data.crmUserId = key;
      });

      socket.on('send_message', (data) => {
        const { recipientId, message } = data;
        const recipientSockets = userSockets.get(String(recipientId));
        if (recipientSockets) {
          for (const socketId of recipientSockets) {
            io.to(socketId).emit('receive_message', message);
          }
        }
      });

      socket.on('disconnect', () => {
        const key = socket.data.crmUserId;
        if (!key) return;
        const sockets = userSockets.get(key);
        sockets?.delete(socket.id);
        if (sockets?.size === 0) userSockets.delete(key);
      });
    });

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      void cacheWarmup.then((ready) => {
        console.log(`[Cache] Redis ${ready ? 'ready' : 'not configured/unavailable'}; local fallback active`);
      });
      setImmediate(() => {
        void startBackgroundRuntimes();
      });
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

