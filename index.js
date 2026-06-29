const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// En un entorno real esto va en variables de entorno, pero para tu proyecto podemos dejarlo así:
const JWT_SECRET = process.env.JWT_SECRET || 'MASTERTRONICSSECRETKEY';
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
// Middleware de Protección JWT
// ==========================================
const verificarToken = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ error: 'Acceso denegado. Se requiere token.' });

  try {
    // Verificamos si el token es válido y no ha expirado
    const verificado = jwt.verify(token.replace('Bearer ', ''), JWT_SECRET);
    req.user = verificado; // Guardamos los datos del usuario en la petición
    next(); // Le permitimos pasar a la ruta
  } catch (error) {
    res.status(400).json({ error: 'Token no válido o expirado.' });
  }
};

// ==========================================
// 3. RUTAS DE HISTORIAL Y HARDWARE (MONGODB)
// ==========================================
// Nota: POST /logs no lleva verificarToken porque es usado por el ESP32
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

app.get('/logs', verificarToken, async (req, res) => {
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

app.get('/logs/user/:id', verificarToken, async (req, res) => {
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

// Nota: No lleva token, el ESP32 la utiliza para saber si debe abrir la puerta
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
app.get('/stats/summary', verificarToken, async (req, res) => {
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

app.get('/stats/top-users', verificarToken, async (req, res) => {
  try {
    const topUsers = await AccessLog.aggregate([
      { $match: { worker_id: { $ne: 0 } } }, 
      { $group: { 
          _id: "$worker_id", 
          first_name: { $first: "$first_name" }, 
          last_name: { $first: "$last_name" }, 
          activity_count: { $sum: 1 } 
      }},
      { $sort: { activity_count: -1 } },
      { $limit: 5 }
    ]);
    res.json(topUsers);
  } catch (error) { 
    console.error("Error en Top Usuarios:", error);
    res.status(500).json({ error: 'Error leyendo MongoDB' }); 
  }
});

app.get('/logs/report', verificarToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = new Date(`${startDate}T00:00:00-04:00`);
    const end = new Date(`${endDate}T23:59:59-04:00`);

    const logs = await AccessLog.find({ 
      created_at: { $gte: start, $lte: end } 
    }).sort({ created_at: -1 });
    
    res.json(logs);
  } catch (error) { 
    console.error("Error en PDF:", error);
    res.status(500).json({ error: 'Error leyendo MongoDB para el reporte' }); 
  }
});

// ==========================================
// 5. RUTAS CRUD PARA USUARIOS (POSTGRESQL)
// ==========================================
app.get('/workers', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, first_name, last_name, username, worker_code, fingerprint_id, access_level FROM workers ORDER BY id ASC`); 
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Error obteniendo usuarios' }); }
});

app.post('/workers', verificarToken, async (req, res) => {
  const { first_name, last_name, username, worker_code, fingerprint_id, access_level, password } = req.body;
  
  // Convertimos textos vacíos a null para evitar choques en PostgreSQL
  const f_id = (fingerprint_id && fingerprint_id.toString().trim() !== '') ? parseInt(fingerprint_id) : null; 
  const w_code = (worker_code && worker_code.trim() !== '') ? worker_code : null;
  
  try {
    const hashedPassword = await bcrypt.hash(password || '1234', 10);
    const result = await pool.query(
      `INSERT INTO workers (first_name, last_name, username, worker_code, fingerprint_id, access_level, password) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [first_name, last_name, username, w_code, f_id, access_level !== undefined ? access_level : 0, hashedPassword] 
    );
    const nuevoUsuario = result.rows[0];
    delete nuevoUsuario.password;
    res.status(201).json(nuevoUsuario);
  } catch (error) { 
    console.error("Error BD al crear:", error);
    // Cambiamos la alerta genérica por el error real de la base de datos
    res.status(500).json({ error: `Falla SQL: ${error.message}` }); 
  }
});

app.put('/workers/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, username, worker_code, fingerprint_id, access_level, password } = req.body;
  
  const f_id = (fingerprint_id && fingerprint_id.toString().trim() !== '') ? parseInt(fingerprint_id) : null;
  const w_code = (worker_code && worker_code.trim() !== '') ? worker_code : null;

  try {
    let result;
    if (password && password.trim() !== '') {
      const hashedPassword = await bcrypt.hash(password, 10);
      result = await pool.query(
        `UPDATE workers SET first_name = $1, last_name = $2, username = $3, worker_code = $4, fingerprint_id = $5, access_level = $6, password = $7 WHERE id = $8 RETURNING *`, 
        [first_name, last_name, username, w_code, f_id, access_level, hashedPassword, id]
      );
    } else {
      result = await pool.query(
        `UPDATE workers SET first_name = $1, last_name = $2, username = $3, worker_code = $4, fingerprint_id = $5, access_level = $6 WHERE id = $7 RETURNING *`, 
        [first_name, last_name, username, w_code, f_id, access_level, id]
      );
    }
    const usuarioActualizado = result.rows[0];
    if (usuarioActualizado && usuarioActualizado.password) delete usuarioActualizado.password;
    res.json(usuarioActualizado);
  } catch (error) { 
    console.error("Error BD al crear:", error);
    // Cambiamos la alerta genérica por el error real de la base de datos
    res.status(500).json({ error: `Falla SQL: ${error.message}` }); 
  }
});

app.delete('/workers/:id', verificarToken, async (req, res) => {
  try { await pool.query('DELETE FROM workers WHERE id = $1', [req.params.id]); res.json({ message: 'OK' }); } catch (error) { res.status(500).json({ error: 'Error' }); }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM workers WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    
    if (match) {
      delete user.password;
      
      const token = jwt.sign(
        { id: user.id, access_level: user.access_level }, 
        JWT_SECRET, 
        { expiresIn: '8h' }
      );
      
      res.json({ success: true, user: user, token: token });
    } else {
      res.status(401).json({ error: 'Contraseña incorrecta' });
    }
  } catch (error) { 
    res.status(500).json({ error: 'Error en el servidor' }); 
  }
});

// ==========================================
// 6. RUTAS DEL HARDWARE NFC Y HUELLAS
// ==========================================
let nfcEnEspera = "";
let huellaEnEspera = null;

app.post('/hardware/nfc-scan', async (req, res) => {
  const { rfid_code } = req.body;
  try {
    const result = await pool.query('SELECT id, first_name, last_name FROM workers WHERE worker_code = $1', [rfid_code]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      await new AccessLog({ lock_id: 1, worker_id: user.id, first_name: user.first_name, last_name: user.last_name, action_type: 'NFC Unlocked', is_unlocked: true }).save();
      res.json({ success: true, unlock: true }); 
    } else {
      await new AccessLog({ lock_id: 1, worker_id: 0, first_name: 'NFC', last_name: 'Desconocido', action_type: 'NFC Denegado', is_unlocked: false }).save();
      res.json({ success: false, unlock: false });
    }
  } catch (error) { res.status(500).json({ error: 'Error NFC' }); }
});

app.post('/hardware/fingerprint-scan', async (req, res) => {
  const { finger_id } = req.body;
  try {
    const result = await pool.query('SELECT id, first_name, last_name FROM workers WHERE fingerprint_id = $1', [finger_id]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      await new AccessLog({ lock_id: 1, worker_id: user.id, first_name: user.first_name, last_name: user.last_name, action_type: 'Biometric Unlocked', is_unlocked: true }).save();
      res.json({ success: true, unlock: true }); 
    } else {
      await new AccessLog({ lock_id: 1, worker_id: 0, first_name: 'Huella', last_name: `No. ${finger_id}`, action_type: 'Biometric Denegado', is_unlocked: false }).save();
      res.json({ success: false, unlock: false });
    }
  } catch (error) { res.status(500).json({ error: 'Error Huella' }); }
});

app.post('/hardware/enroll-nfc', (req, res) => {
  nfcEnEspera = req.body.rfid_code;
  res.json({ success: true });
});

app.post('/hardware/enroll-fingerprint', (req, res) => {
  huellaEnEspera = req.body.finger_id;
  res.json({ success: true });
});

app.get('/hardware/last-nfc', verificarToken, (req, res) => { 
  const codigo = nfcEnEspera;
  nfcEnEspera = ""; 
  res.json({ rfid_code: codigo }); 
});

app.get('/hardware/last-fingerprint', verificarToken, (req, res) => { 
  const huella = huellaEnEspera;
  huellaEnEspera = null; 
  res.json({ finger_id: huella }); 
});

// ==========================================
// RUTA TEMPORAL DE MANTENIMIENTO
// ==========================================
app.get('/reparar-db', async (req, res) => {
  try {
    // Sincroniza el contador interno de IDs con el número más alto que exista
    await pool.query("SELECT setval(pg_get_serial_sequence('workers', 'id'), coalesce(max(id),0) + 1, false) FROM workers;");
    res.send("<h1>¡Mantenimiento exitoso!</h1><p>El contador automático de PostgreSQL ha sido sincronizado. Cierra esta ventana y prueba crear un usuario en la app.</p>");
  } catch (error) {
    res.send("Error al reparar la base de datos: " + error.message);
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Servidor corriendo en el puerto ${PORT}`); });