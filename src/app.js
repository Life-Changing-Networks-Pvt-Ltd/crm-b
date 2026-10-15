import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import compression from 'compression';
import dotenv from 'dotenv';
import { notFound, errorHandler } from './middleware/errorMiddleware.js';
import { performanceTiming } from './middleware/performanceTiming.js';
import { protect } from './middleware/authMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import roleRoutes from './routes/roleRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import userRoutes from './routes/userRoutes.js';
import companyRoutes from './routes/companyRoutes.js';
import employeeRoutes from './routes/employeeRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import eventRoutes from './routes/eventRoutes.js';
import noteRoutes from './routes/noteRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import reportsRoutes from './routes/reportsRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import telephonyRoutes from './routes/telephonyRoutes.js';
import whatsappRoutes from './routes/whatsappRoutes.js';
import followUpRoutes from './routes/followUpRoutes.js';
import teamRoutes from './routes/teamRoutes.js';
import templateAccessRoutes from './routes/templateAccessRoutes.js';
import auditLogRoutes from './routes/auditLogRoutes.js';
import {
  resolveEffectiveAccess,
  userHasPermission,
} from './services/accessControlService.js';
import { PERMISSIONS } from './constants/permissions.js';

dotenv.config();

// The shared WhatsApp module uses this name; CRM already connects with
// MONGODB_URI, so both applications intentionally use the same database.
process.env.MONGODB_URL ||= process.env.MONGODB_URI;
let whatsappMarketingRouterPromise;
const createLazyRouter = (loadRouter) => {
  let routerPromise;
  return (req, res, next) => {
    routerPromise ||= loadRouter().catch((error) => {
      routerPromise = null;
      throw error;
    });
    void routerPromise.then((router) => router(req, res, next)).catch(next);
  };
};
const lazyEmailMarketingRouter = createLazyRouter(
  () => import('./modules/email-marketing/index.js').then((module) => module.default),
);
const loadWhatsAppMarketingRouter = () => {
  if (!whatsappMarketingRouterPromise) {
    whatsappMarketingRouterPromise = import('./modules/whatsapp-marketing/index.js')
      .then((module) => module.default)
      .catch((error) => {
        whatsappMarketingRouterPromise = null;
        throw error;
      });
  }
  return whatsappMarketingRouterPromise;
};
const lazyWhatsAppMarketingRouter = (req, res, next) => {
  void loadWhatsAppMarketingRouter()
    .then((router) => router(req, res, next))
    .catch(next);
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const envEnabled = (name, fallback = true) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
};

const bridgeCrmUserToWhatsApp = (req, res, next) => {
  if (req.path.startsWith('/webhook/whatsapp')) return next();
  return protect(req, res, async () => {
    try {
      const crmUser = req.user;
      const access = await resolveEffectiveAccess(crmUser);
    if (!userHasPermission(access, PERMISSIONS.WHATSAPP_MODULE_VIEW)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to open WhatsApp Marketing',
      });
    }

    const modulePath = req.path.toLowerCase();
    const method = req.method.toUpperCase();
    let requiredPermissions = [];
    if (modulePath.startsWith('/templates')) {
      requiredPermissions = method === 'GET'
        ? [
            PERMISSIONS.WHATSAPP_TEMPLATES_USE,
            PERMISSIONS.WHATSAPP_TEMPLATES_CREATE,
            PERMISSIONS.WHATSAPP_TEMPLATES_EDIT,
          ]
        : [
            method === 'POST'
              ? PERMISSIONS.WHATSAPP_TEMPLATES_CREATE
              : PERMISSIONS.WHATSAPP_TEMPLATES_EDIT,
          ];
    } else if (
      modulePath.startsWith('/broadcast')
      || modulePath.startsWith('/drip-campaigns')
      || modulePath.startsWith('/automation')
    ) {
      requiredPermissions = [PERMISSIONS.WHATSAPP_CAMPAIGNS_MANAGE];
    } else if (modulePath.startsWith('/whatsapp/send-template')) {
      requiredPermissions = [
        PERMISSIONS.WHATSAPP_TEMPLATES_USE,
        PERMISSIONS.WHATSAPP_SEND_LEAD,
      ];
    } else if (modulePath.startsWith('/inbox/send')) {
      requiredPermissions = [PERMISSIONS.WHATSAPP_SEND_LEAD];
    }

    const adminOnlyModulePaths = [
      '/credentials',
      '/users',
      '/agents',
      '/integrations',
      '/facebook',
      '/map-agent',
    ];
    if (!access.isAdmin && adminOnlyModulePaths.some((prefix) => modulePath.startsWith(prefix))) {
      return res.status(403).json({
        success: false,
        message: 'This WhatsApp administration feature is restricted',
      });
    }
    if (
      requiredPermissions.length
      && (
        modulePath.startsWith('/whatsapp/send-template')
          ? !requiredPermissions.every((permission) => userHasPermission(access, permission))
          : !requiredPermissions.some((permission) => userHasPermission(access, permission))
      )
    ) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this WhatsApp action',
      });
    }

    const normalizedRole = ['admin', 'superadmin', 'super_admin'].includes(
      String(crmUser?.role || '').toLowerCase()
    ) ? 'admin' : 'user';
    const pageAccess = new Set();
    if (!access.isAdmin) {
      if (access.grants.includes(PERMISSIONS.WHATSAPP_MODULE_VIEW)) pageAccess.add('dashboard');
      if (
        access.grants.includes(PERMISSIONS.WHATSAPP_TEMPLATES_CREATE)
        || access.grants.includes(PERMISSIONS.WHATSAPP_TEMPLATES_EDIT)
      ) pageAccess.add('templates');
      if (access.grants.includes(PERMISSIONS.WHATSAPP_CAMPAIGNS_MANAGE)) pageAccess.add('broadcast');
      if (
        access.grants.includes(PERMISSIONS.WHATSAPP_TEMPLATES_USE)
        || access.grants.includes(PERMISSIONS.WHATSAPP_SEND_LEAD)
      ) pageAccess.add('inbox');
      access.permissions
        .filter((permission) => !String(permission).startsWith('/'))
        .forEach((permission) => pageAccess.add(permission));
    }
    const whatsappUser = {
      id: `crm:${crmUser._id}`,
      accountId: String(crmUser._id),
      username: crmUser.email || `crm_${crmUser._id}`,
      name: crmUser.name || 'CRM User',
      email: crmUser.email || '',
      role: normalizedRole,
      pageAccess: Array.from(pageAccess),
    };
    req.headers['x-user-id'] = whatsappUser.id;
    req.headers['x-user-role'] = whatsappUser.role;
    req.headers['x-user-name'] = whatsappUser.name;
    req.headers['x-user'] = JSON.stringify(whatsappUser);
      next();
    } catch (error) {
      next(error);
    }
  });
};

const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8080',
  'https://crm.sellerslogin.com',
  'http://crm.sellerslogin.com',
  'https://ophcrm.sellerslogin.com',
  'http://ophcrm.sellerslogin.com',
  'https://www.ophcrm.sellerslogin.com',
];

const normalizeOrigin = (origin) => origin?.trim().replace(/\/$/, '');

const allowedOrigins = [
  ...defaultAllowedOrigins,
  ...(process.env.CLIENT_ORIGIN || '').split(','),
]
  .map(normalizeOrigin)
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id', 'x-user-role', 'x-user-name', 'x-user'],
  optionsSuccessStatus: 204,
};

// Serve uploads folder statically
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Security and utility middlewares
if (envEnabled('PERFORMANCE_TIMING_ENABLED')) app.use(performanceTiming);
if (envEnabled('RESPONSE_COMPRESSION_ENABLED')) {
  app.use(compression({
    threshold: Math.max(Number(process.env.RESPONSE_COMPRESSION_THRESHOLD_BYTES || 1024), 512),
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    },
  }));
}
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100000, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  message: 'Too many requests from this IP, please try again after 15 minutes',
});

app.use('/api', limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', userRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/telephony', telephonyRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/follow-ups', followUpRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/template-access', templateAccessRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/email-marketing', lazyEmailMarketingRouter);
app.use('/api/whatsapp-marketing', bridgeCrmUserToWhatsApp, lazyWhatsAppMarketingRouter);

// Root route
app.get('/', (req, res) => {
  res.send('CRM API is running...');
});

// Error Handling middlewares
app.use(notFound);
app.use(errorHandler);

export default app;
