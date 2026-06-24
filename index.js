const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. CONEXIONES A BASES DE DATOS (POLÍGLOTA)
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('¡Conexión políglota exitosa a MongoDB Atlas!'))
  .catch((err) => console.error('Error conectando a MongoDB:', err));

// ==========================================
// 2. MODELOS Y VARIABLES EN MEMORIA
// ==========================================
const logSchema = new mongoose.Schema({
  lock_id: Number,
  worker_id: Number,      
  first_name: String,     
  last_name: String,
  action_type: String,
  is_unlocked: Boolean,
  created_at: { type: Date, default: Date.now } 
});

const AccessLog = mongoose.model('AccessLog', logSchema);

const getCaracasDateRange = (dateStr) => {
  const startOfDay = new Date(`${dateStr}T00:00:00-04:00`);
  const endOfDay = new Date(`${dateStr}T23:59:59-04:00`);
  return { startOfDay, endOfDay };
};

// COLA DE COMANDOS Y MEMORIAS TEMPORALES PARA REGISTRO
const comandosPendientes = { 1: false };
let ultimaTarjetaDesconocida = ""; 
let ultimaHuellaDesconocida = null; // NUEVO: Memoria para huellas

// ==========================================
// 3. RUTAS DE HISTORIAL Y HARDWARE (MONGODB)
// ==========================================
app.post('/logs', async (req, res) => {
  const { lock_id, nfc_card_id, action_type, is_unlocked } = req.body;
  try {
    const ultimoLog = await AccessLog.findOne({ lock_id: lock_id }).sort({ created_at: -1 });
    if (ultimoLog && (Date.now() - new Date(ultimoLog.created_at).getTime() < 3000)) { 
      return res.status(429).json({ error: 'cooldown', message: 'El candado ya está abierto' });
    }

    const userResult = await pool.query('SELECT first_name, last_name FROM workers WHERE id = $1', [nfc_card_id]);
    const user = userResult.rows[0] || { first_name: 'Usuario', last_name: 'Desconocido' };

    const nuevoLog = new AccessLog({
      lock_id, worker_id: nfc_card_id, first_name: user.first_name,
      last_name: user.last_name, action_type, is_unlocked
    });

    await nuevoLog.save();
    comandosPendientes[lock_id] = true; 
    
    const logData = nuevoLog.toObject();
    logData.id = logData._id; 
    res.status(201).json(logData);
  } catch (error) {
    res.status(500).json({ error: 'Error al insertar en MongoDB' });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const date = req.query.date; 

    let query = {};
    if (date && date !== 'undefined' && date !== 'null') {
      const { startOfDay, endOfDay } = getCaracasDateRange(date);
      query.created_at = { $gte: startOfDay, $lte: endOfDay };
    }

    const [result, totalItems] = await Promise.all([
      AccessLog.find(query).sort({ created_at: -1 }).skip(offset).limit(limit),
      AccessLog.countDocuments(query)
    ]);

    const data = result.map(doc => ({
      id: doc._id, lock_id: doc.lock_id, worker_id: doc.worker_id,
      first_name: doc.first_name, last_name: doc.last_name,
      action_type: doc.action_type, is_unlocked: doc.is_unlocked, created_at: doc.created_at
    }));

    res.json({ data, currentPage: page, totalPages: Math.ceil(totalItems / limit) || 1, totalItems });
  } catch (error) { res.status(500).json({ error: 'Error leyendo MongoDB' }); }
});

app.get('/logs/user/:id', async (req, res) => {
  // Misma lógica de /logs pero filtrando por worker_id
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const date = req.query.date;
    let query = { worker_id: parseInt(id) };
    if (date && date !== 'undefined' && date !== 'null') {
      const { startOfDay, endOfDay } = getCaracasDateRange(date);
      query.created_at = { $gte: startOfDay, $lte: endOfDay };
    }
    const [result, totalItems] = await Promise.all([
      AccessLog.find(query).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit),
      AccessLog.countDocuments(query)
    ]);
    res.json({ data: result.map(doc => ({ id: doc._id, ...doc._doc })), currentPage: page, totalPages: Math.ceil(totalItems / limit) || 1, totalItems });
  } catch (error) { res.status(500).json({ error: 'Error obteniendo historial' }); }
});

app.get('/hardware/lock-status', async (req, res) => {
  try {
    const isUnlocked = comandosPendientes[1] || false;
    comandosPendientes[1] = false; 
    res.json({ unlocked: isUnlocked });
  } catch (error) { res.status(500).json({ error: 'Error leyendo estado del hardware' }); }
});

// ==========================================
// 4. ESTADÍSTICAS
// ==========================================
app.get('/stats/summary', async (req, res) => {
  try {
    const tzDate = new Date();
    const { startOfDay, endOfDay } = getCaracasDateRange(`${tzDate.getFullYear()}-${String(tzDate.getMonth() + 1).padStart(2, '0')}-${String(tzDate.getDate()).padStart(2, '0')}`);
    const [totalLogs, todayLogs, totalUnlocks, usersResult] = await Promise.all([
      AccessLog.countDocuments(), AccessLog.countDocuments({ created_at: { $gte: startOfDay, $lte: endOfDay } }),
      AccessLog.countDocuments({ is_unlocked: true }), pool.query('SELECT COUNT(*) as count FROM workers')
    ]);
    res.json({ total_logs: totalLogs, total_users: parseInt(usersResult.rows[0].count), today_logs: todayLogs, total_unlocks: totalUnlocks });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// 5. RUTAS CRUD PARA USUARIOS (POSTGRESQL) - ACTUALIZADO PARA HUELLAS
// ==========================================
app.get('/workers', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, first_name, last_name, username, worker_code, fingerprint_id, access_level FROM workers ORDER BY id ASC`); 
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error obteniendo usuarios' }); }
});

app.post('/workers', async (req, res) => {
  const { first_name, last_name, username, worker_code, fingerprint_id, access_level, password } = req.body;
  // Convertimos string vacío a NULL para no romper la base de datos
  const f_id = (fingerprint_id && fingerprint_id !== '') ? parseInt(fingerprint_id) : null; 
  
  try {
    const hashedPassword = await bcrypt.hash(password || '1234', 10);
    const result = await pool.query(
      `INSERT INTO workers (first_name, last_name, username, worker_code, fingerprint_id, access_level, password) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [first_name, last_name, username, worker_code, f_id, access_level || 0, hashedPassword] 
    );
    const nuevoUsuario = result.rows[0];
    delete nuevoUsuario.password;
    res.status(201).json(nuevoUsuario);
  } catch (error) { res.status(500).json({ error: 'Error creando usuario' }); }
});

app.put('/workers/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, username, worker_code, fingerprint_id, access_level, password } = req.body;
  const f_id = (fingerprint_id && fingerprint_id !== '') ? parseInt(fingerprint_id) : null;

  try {
    let result;
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      result = await pool.query(
        `UPDATE workers SET first_name = $1, last_name = $2, username = $3, worker_code = $4, fingerprint_id = $5, access_level = $6, password = $7 WHERE id = $8 RETURNING *`, 
        [first_name, last_name, username, worker_code, f_id, access_level, hashedPassword, id]
      );
    } else {
      result = await pool.query(
        `UPDATE workers SET first_name = $1, last_name = $2, username = $3, worker_code = $4, fingerprint_id = $5, access_level = $6 WHERE id = $7 RETURNING *`, 
        [first_name, last_name, username, worker_code, f_id, access_level, id]
      );
    }
    const usuarioActualizado = result.rows[0];
    if (usuarioActualizado && usuarioActualizado.password) delete usuarioActualizado.password;
    res.json(usuarioActualizado);
  } catch (error) { res.status(500).json({ error: 'Error actualizando usuario' }); }
});

app.delete('/workers/:id', async (req, res) => {
  try { await pool.query('DELETE FROM workers WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body; 
  try {
    const result = await pool.query('SELECT id, first_name, last_name, username, worker_code, access_level, password FROM workers WHERE username = $1', [username]);
    if (result.rows.length > 0 && await bcrypt.compare(password, result.rows[0].password)) {
      delete result.rows[0].password;
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales incorrectas' });
    }
  } catch (error) { res.status(500).json({ error: 'Error en el servidor' }); }
});

// ==========================================
// 6. RUTAS DEL HARDWARE NFC Y HUELLAS
// ==========================================
app.post('/hardware/nfc-scan', async (req, res) => {
  const { rfid_code } = req.body;
  try {
    const result = await pool.query('SELECT id, first_name, last_name FROM workers WHERE worker_code = $1', [rfid_code]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      await new AccessLog({ lock_id: 1, worker_id: user.id, first_name: user.first_name, last_name: user.last_name, action_type: 'NFC Unlocked', is_unlocked: true }).save();
      res.json({ success: true, unlock: true }); 
    } else {
      ultimaTarjetaDesconocida = rfid_code; 
      await new AccessLog({ lock_id: 1, worker_id: 0, first_name: 'NFC', last_name: 'Desconocido', action_type: 'NFC Denegado', is_unlocked: false }).save();
      res.json({ success: false, unlock: false });
    }
  } catch (error) { res.status(500).json({ error: 'Error NFC' }); }
});

app.get('/hardware/last-nfc', (req, res) => { res.json({ rfid_code: ultimaTarjetaDesconocida }); });

// NUEVO: Escáner de Huella Dactilar
app.post('/hardware/fingerprint-scan', async (req, res) => {
  const { finger_id } = req.body;
  try {
    const result = await pool.query('SELECT id, first_name, last_name FROM workers WHERE fingerprint_id = $1', [finger_id]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      await new AccessLog({ lock_id: 1, worker_id: user.id, first_name: user.first_name, last_name: user.last_name, action_type: 'Biometric Unlocked', is_unlocked: true }).save();
      res.json({ success: true, unlock: true }); 
    } else {
      ultimaHuellaDesconocida = finger_id; 
      await new AccessLog({ lock_id: 1, worker_id: 0, first_name: 'Huella', last_name: `No. ${finger_id}`, action_type: 'Biometric Denegado', is_unlocked: false }).save();
      res.json({ success: false, unlock: false });
    }
  } catch (error) { res.status(500).json({ error: 'Error Huella' }); }
});

app.get('/hardware/last-fingerprint', (req, res) => { res.json({ finger_id: ultimaHuellaDesconocida }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor corriendo en el puerto ${PORT}`); });