const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. CONEXIONES A BASES DE DATOS (POLÍGLOTA)
// ==========================================

// PostgreSQL (Para Usuarios/Workers)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// MongoDB Atlas (Para Logs/Historial en tiempo real)
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('¡Conexión políglota exitosa a MongoDB Atlas!'))
  .catch((err) => console.error('Error conectando a MongoDB:', err));

// ==========================================
// 2. MODELO DE MONGOOSE PARA LOS LOGS
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

// Función auxiliar para calcular rangos de fecha en hora de Venezuela (-04:00)
const getCaracasDateRange = (dateStr) => {
  const startOfDay = new Date(`${dateStr}T00:00:00-04:00`);
  const endOfDay = new Date(`${dateStr}T23:59:59-04:00`);
  return { startOfDay, endOfDay };
};

// ==========================================
// 3. RUTAS DE HISTORIAL Y HARDWARE (MIGRADO A MONGODB)
// ==========================================

// POST: Guardar un nuevo acceso (El Puente Políglota)
app.post('/logs', async (req, res) => {
  const { lock_id, nfc_card_id, action_type, is_unlocked } = req.body;

  try {
    // 1. Buscamos la identidad en PostgreSQL
    const userResult = await pool.query(
      'SELECT first_name, last_name FROM workers WHERE id = $1', 
      [nfc_card_id]
    );
    const user = userResult.rows[0] || { first_name: 'Usuario', last_name: 'Desconocido' };

    // 2. Guardamos todo el paquete en MongoDB
    const nuevoLog = new AccessLog({
      lock_id,
      worker_id: nfc_card_id,
      first_name: user.first_name,
      last_name: user.last_name,
      action_type,
      is_unlocked
    });

    await nuevoLog.save();
    
    // Adaptamos la respuesta para que la App no se rompa (MongoDB usa _id en vez de id)
    const logData = nuevoLog.toObject();
    logData.id = logData._id; 
    
    res.status(201).json(logData);
  } catch (error) {
    console.error("Error en escritura políglota:", error);
    res.status(500).json({ error: 'Error al insertar en MongoDB' });
  }
});

// GET: Obtener logs con Paginación (Desde MongoDB)
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

    // Ejecutamos búsqueda y conteo en paralelo en Atlas
    const [result, totalItems] = await Promise.all([
      AccessLog.find(query).sort({ created_at: -1 }).skip(offset).limit(limit),
      AccessLog.countDocuments(query)
    ]);

    const totalPages = Math.ceil(totalItems / limit);

    // Mapeamos para enviar "id" en lugar de "_id"
    const data = result.map(doc => ({
      id: doc._id, lock_id: doc.lock_id, worker_id: doc.worker_id,
      first_name: doc.first_name, last_name: doc.last_name,
      action_type: doc.action_type, is_unlocked: doc.is_unlocked, created_at: doc.created_at
    }));

    res.json({ data, currentPage: page, totalPages: totalPages === 0 ? 1 : totalPages, totalItems });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error leyendo MongoDB' });
  }
});

// GET: Obtener logs de un usuario específico (Desde MongoDB)
app.get('/logs/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const date = req.query.date;

    let query = { worker_id: parseInt(id) };

    if (date && date !== 'undefined' && date !== 'null') {
      const { startOfDay, endOfDay } = getCaracasDateRange(date);
      query.created_at = { $gte: startOfDay, $lte: endOfDay };
    }

    const [result, totalItems] = await Promise.all([
      AccessLog.find(query).sort({ created_at: -1 }).skip(offset).limit(limit),
      AccessLog.countDocuments(query)
    ]);

    const data = result.map(doc => ({ id: doc._id, ...doc._doc }));
    const totalPages = Math.ceil(totalItems / limit);

    res.json({ data, currentPage: page, totalPages: totalPages === 0 ? 1 : totalPages, totalItems });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo historial del usuario en MongoDB' });
  }
});

// GET: Consultar el estado actual del candado físico (Sincronización App/ESP32)
app.get('/hardware/lock-status', async (req, res) => {
  try {
    const ultimoLog = await AccessLog.findOne({ lock_id: 1 }).sort({ created_at: -1 });
    const isUnlocked = ultimoLog ? ultimoLog.is_unlocked : false;
    res.json({ unlocked: isUnlocked });
  } catch (error) {
    res.status(500).json({ error: 'Error leyendo estado del hardware en MongoDB' });
  }
});

// GET: Reporte PDF de fechas (Desde MongoDB)
app.get('/logs/report', async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const start = new Date(`${startDate}T00:00:00-04:00`);
    const end = new Date(`${endDate}T23:59:59-04:00`);
    
    const result = await AccessLog.find({ created_at: { $gte: start, $lte: end } }).sort({ created_at: -1 });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error generando reporte desde MongoDB' });
  }
});

// ==========================================
// 4. ESTADÍSTICAS (MONGODB + POSTGRESQL)
// ==========================================

app.get('/stats/summary', async (req, res) => {
  try {
    const tzDate = new Date();
    const year = tzDate.getFullYear();
    const month = String(tzDate.getMonth() + 1).padStart(2, '0');
    const day = String(tzDate.getDate()).padStart(2, '0');
    const { startOfDay, endOfDay } = getCaracasDateRange(`${year}-${month}-${day}`);

    const [totalLogs, todayLogs, totalUnlocks, usersResult] = await Promise.all([
      AccessLog.countDocuments(),
      AccessLog.countDocuments({ created_at: { $gte: startOfDay, $lte: endOfDay } }),
      AccessLog.countDocuments({ is_unlocked: true }),
      pool.query('SELECT COUNT(*) as count FROM workers')
    ]);

    res.json({
      total_logs: totalLogs,
      total_users: parseInt(usersResult.rows[0].count),
      today_logs: todayLogs,
      total_unlocks: totalUnlocks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/stats/top-users', async (req, res) => {
  try {
    // Pipeline de agregación rápida en MongoDB
    const topUsers = await AccessLog.aggregate([
      { $group: { _id: "$worker_id", first_name: { $first: "$first_name" }, last_name: { $first: "$last_name" }, activity_count: { $sum: 1 } } },
      { $sort: { activity_count: -1 } },
      { $limit: 5 }
    ]);
    res.json(topUsers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 5. RUTAS CRUD PARA USUARIOS (MANTENIDAS EN POSTGRESQL)
// ==========================================

app.get('/workers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM workers ORDER BY id ASC'); 
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

app.post('/workers', async (req, res) => {
  const { first_name, last_name, worker_code, access_level, password } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO workers (first_name, last_name, worker_code, access_level, password) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [first_name, last_name, worker_code, access_level || 0, password || '1234'] 
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error creando usuario' });
  }
});

app.put('/workers/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, worker_code, access_level, password } = req.body;
  try {
    const result = await pool.query(
      `UPDATE workers SET first_name = $1, last_name = $2, worker_code = $3, access_level = $4, password = $5 
       WHERE id = $6 RETURNING *`, 
      [first_name, last_name, worker_code, access_level, password, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando usuario' });
  }
});

app.delete('/workers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM workers WHERE id = $1', [id]); 
    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'No se puede eliminar.' });
  }
});

app.post('/login', async (req, res) => {
  const { worker_code, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, first_name, last_name, worker_code, access_level FROM workers WHERE worker_code = $1 AND password = $2',
      [worker_code, password]
    );

    if (result.rows.length > 0) {
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});