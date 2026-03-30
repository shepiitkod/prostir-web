const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app    = express();
const DB_PATH = path.join(__dirname, 'db.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(__dirname));

/* ─── DB helpers ─── */
function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}
function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

/* ──────────────────────────────────────────
   GET /api/tables/:venueId
   Returns all tables for a venue with current status
────────────────────────────────────────── */
app.get('/api/tables/:venueId', (req, res) => {
  const db = readDb();
  const tables = db.tables.filter(t => t.venueId === req.params.venueId);
  if (!tables.length) return res.status(404).json({ error: 'Venue not found' });
  res.json(tables);
});

/* ──────────────────────────────────────────
   GET /api/desks/:venueId
   Returns all co-working desks
────────────────────────────────────────── */
app.get('/api/desks/:venueId', (req, res) => {
  const db = readDb();
  const desks = db.desks.filter(d => d.venueId === req.params.venueId);
  res.json(desks);
});

/* ──────────────────────────────────────────
   GET /api/apartments
   Returns apartment listings
────────────────────────────────────────── */
app.get('/api/apartments', (req, res) => {
  const db = readDb();
  res.json(db.apartments);
});

/* ──────────────────────────────────────────
   GET /api/bookings
   Returns all confirmed bookings
────────────────────────────────────────── */
app.get('/api/bookings', (req, res) => {
  const db = readDb();
  res.json(db.bookings.filter(b => b.status !== 'cancelled'));
});

/* ──────────────────────────────────────────
   POST /api/book
   Body: { tableId, userId, time, date }
   Prevents double-booking (409 on conflict)
────────────────────────────────────────── */
app.post('/api/book', (req, res) => {
  const { tableId, userId = 'user-001', time, date } = req.body;

  if (!tableId || !time) {
    return res.status(400).json({ error: 'tableId and time are required' });
  }

  const db = readDb();

  const tableIdInt = parseInt(tableId);
  const table = db.tables.find(t => t.id === tableIdInt);
  if (!table) return res.status(404).json({ error: 'Table not found' });
  if (table.status === 'booked') {
    return res.status(409).json({ error: 'Table is already booked' });
  }

  const bookingDate = date || new Date().toISOString().split('T')[0];

  const conflict = db.bookings.find(b =>
    b.tableId === tableIdInt &&
    b.time    === time       &&
    b.date    === bookingDate &&
    b.status  !== 'cancelled'
  );
  if (conflict) {
    return res.status(409).json({ error: 'Table already booked for this time slot' });
  }

  const booking = {
    id:        Date.now(),
    tableId:   tableIdInt,
    userId,
    time,
    date:      bookingDate,
    venue:     table.venueId,
    seats:     table.seats,
    view:      table.view,
    status:    'confirmed',
    createdAt: new Date().toISOString(),
  };

  db.bookings.push(booking);
  table.status = 'booked';

  writeDb(db);
  res.status(201).json({ success: true, booking });
});

/* ──────────────────────────────────────────
   DELETE /api/bookings/:id
   Cancel booking and release table
────────────────────────────────────────── */
app.delete('/api/bookings/:id', (req, res) => {
  const db = readDb();
  const id = parseInt(req.params.id);
  const booking = db.bookings.find(b => b.id === id);

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Booking already cancelled' });
  }

  booking.status = 'cancelled';

  const table = db.tables.find(t => t.id === booking.tableId);
  if (table) table.status = 'available';

  writeDb(db);
  res.json({ success: true, message: 'Booking cancelled, table released' });
});

/* ──────────────────────────────────────────
   Fallback: serve 404 page for unknown routes
────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  PROSTIR Urban OS running at http://localhost:${PORT}\n`);
});
