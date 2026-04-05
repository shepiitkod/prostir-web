import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { diiaRouter } from './controllers/diia.controller';
import { venueRouter } from './controllers/venue.controller';
import { leadsAdminRouter } from './controllers/leads-admin.controller';
import { ensureUsersTable } from './db/pool';

const app = express();
const __root = path.join(__dirname, '..');
const DB_PATH = path.join(__root, 'db.json');
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '32kb' }));

const staticOpts = {
  maxAge: IS_PROD ? '7d' : 0,
  etag: true,
  lastModified: true,
  index: false,
} as const;
app.use(express.static(path.join(__root, 'public'), { ...staticOpts }));
app.use('/media', express.static(__root, { ...staticOpts, index: false }));

/** `index: false` on static — root URL must be mapped explicitly */
app.get('/', (_req, res) => {
  if (!IS_PROD) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.sendFile(path.join(__root, 'public', 'index.html'));
});

app.use('/auth/diia', diiaRouter);
app.use('/api/venue', venueRouter);
app.use('/api/admin', leadsAdminRouter);

app.get('/admin/leads', (_req, res) => {
  if (!IS_PROD) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.sendFile(path.join(__root, 'public', 'admin', 'leads.html'));
});

app.get('/venue', (_req, res) => {
  res.sendFile(path.join(__root, 'public', 'venue.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'prostir', env: IS_PROD ? 'production' : 'development' });
});

function readDb(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[PROSTIR] Failed to read or parse db.json:', msg);
    throw e;
  }
}

function writeDb(data: unknown): void {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[PROSTIR] Failed to write db.json:', msg);
    throw e;
  }
}

app.get('/api/tables/:venueId', (req, res) => {
  const db = readDb() as {
    tables: Array<{ venueId: string }>;
  };
  const tables = db.tables.filter((t) => t.venueId === req.params.venueId);
  if (!tables.length) {
    return res.status(404).json({ error: 'Venue not found' });
  }
  return res.json(tables);
});

app.get('/api/desks/:venueId', (req, res) => {
  const db = readDb() as {
    desks: Array<{ venueId: string }>;
  };
  const desks = db.desks.filter((d) => d.venueId === req.params.venueId);
  return res.json(desks);
});

app.get('/api/apartments', (_req, res) => {
  const db = readDb() as { apartments: unknown };
  return res.json(db.apartments);
});

app.get('/api/bookings', (_req, res) => {
  const db = readDb() as {
    bookings: Array<{ status: string }>;
  };
  return res.json(db.bookings.filter((b) => b.status !== 'cancelled'));
});

app.post('/api/book', (req, res) => {
  const { tableId, userId = 'user-001', time, date } = req.body as {
    tableId?: unknown;
    userId?: string;
    time?: unknown;
    date?: string;
  };

  if (!tableId || time === undefined || time === null || time === '') {
    return res.status(400).json({ error: 'tableId and time are required' });
  }
  const timeStr = String(time);

  const db = readDb() as {
    tables: Array<{
      id: number;
      venueId: string;
      seats: number;
      view: string;
      status: string;
    }>;
    bookings: Array<{
      tableId: number;
      time: string;
      date: string;
      status: string;
    }>;
  };

  const tableIdInt = parseInt(String(tableId), 10);
  if (!Number.isFinite(tableIdInt)) {
    return res.status(400).json({ error: 'Invalid tableId' });
  }
  const table = db.tables.find((t) => t.id === tableIdInt);
  if (!table) {
    return res.status(404).json({ error: 'Table not found' });
  }
  if (table.status === 'booked') {
    return res.status(409).json({ error: 'Table is already booked' });
  }

  const bookingDate = date || new Date().toISOString().split('T')[0];

  const conflict = db.bookings.find(
    (b) =>
      b.tableId === tableIdInt &&
      b.time === timeStr &&
      b.date === bookingDate &&
      b.status !== 'cancelled'
  );
  if (conflict) {
    return res.status(409).json({ error: 'Table already booked for this time slot' });
  }

  const booking = {
    id: Date.now(),
    tableId: tableIdInt,
    userId,
    time: timeStr,
    date: bookingDate,
    venue: table.venueId,
    seats: table.seats,
    view: table.view,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };

  db.bookings.push(booking);
  table.status = 'booked';

  writeDb(db);
  return res.status(201).json({ success: true, booking });
});

app.delete('/api/bookings/:id', (req, res) => {
  const db = readDb() as {
    bookings: Array<{ id: number; status: string; tableId: number }>;
    tables: Array<{ id: number; status: string }>;
  };
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'Invalid booking id' });
  }
  const booking = db.bookings.find((b) => b.id === id);

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Booking already cancelled' });
  }

  booking.status = 'cancelled';

  const tbl = db.tables.find((t) => t.id === booking.tableId);
  if (tbl) tbl.status = 'available';

  writeDb(db);
  return res.json({ success: true, message: 'Booking cancelled, table released' });
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(__root, 'public', '404.html'));
});

const PORT = Number(process.env.PORT) || 8080;

async function main(): Promise<void> {
  try {
    await ensureUsersTable();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[PROSTIR] PostgreSQL init skipped or failed:', msg);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('PROSTIR Backend live on port ' + PORT);
      console.log('Open http://localhost:' + PORT);
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[PROSTIR] Port ${PORT} is already in use. Free it or pick another port in .env:\n` +
          `  kill $(lsof -ti :${PORT})`
      );
    } else {
      console.error('[PROSTIR] Server failed to start:', err.message);
    }
    process.exit(1);
  });
}

void main();
