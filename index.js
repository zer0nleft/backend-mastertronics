const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = 3000;
const contraseña = '123456'
// Configuración de middlewares
app.use(cors());
app.use(express.json()); // Para poder leer los datos que manda la app

// Configuración de la conexión a PostgreSQL
// Asegúrate de cambiar la contraseña y el usuario si son diferentes

/*const pool = new Pool({
  user: 'postgres',
  host: '127.0.0.1', // <--- EL CAMBIO MÁGICO ESTÁ AQUÍ
  database: 'mastertronics_db',
  password: '123456', 
  port: 5432,
}); */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render requiere SSL para conexiones externas
});

// Ruta 1: Obtener logs con Paginación y Nombres (GET /logs)
app.get('/logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const date = req.query.date; 

    // CAMBIO: Ahora cruzamos los datos con LEFT JOIN para obtener first_name y last_name
    let queryStr = `
      SELECT al.*, w.first_name, w.last_name 
      FROM access_logs al
      LEFT JOIN workers w ON al.nfc_card_id = w.id
    `;
    let countQueryStr = 'SELECT COUNT(*) FROM access_logs al';
    let queryParams = [];
    
    if (date) {
      queryStr += ' WHERE al.created_at::date = $1';
      countQueryStr += ' WHERE al.created_at::date = $1';
      queryParams.push(date);
    }

    const limitParamIndex = queryParams.length + 1;
    const offsetParamIndex = queryParams.length + 2;
    queryStr += ` ORDER BY al.created_at DESC LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`;
    
    const [result, countResult] = await Promise.all([
      pool.query(queryStr, [...queryParams, limit, offset]),
      pool.query(countQueryStr, queryParams)
    ]);

    const totalItems = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalItems / limit);

    res.json({
      data: result.rows,
      currentPage: page,
      totalPages: totalPages === 0 ? 1 : totalPages,
      totalItems: totalItems
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Ruta 2: Guardar un nuevo acceso (POST /logs)
app.post('/logs', async (req, res) => {
  const { lock_id, nfc_card_id, action_type, is_unlocked } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO access_logs (lock_id, nfc_card_id, action_type, is_unlocked) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [lock_id, nfc_card_id, action_type, is_unlocked]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al insertar en PostgreSQL' });
  }
});





// GET: Resumen de estadísticas generales
app.get('/stats/summary', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM access_logs) as total_logs,
        (SELECT COUNT(*) FROM workers) as total_users,
        (SELECT COUNT(*) FROM access_logs WHERE created_at::date = CURRENT_DATE) as today_logs,
        (SELECT COUNT(*) FROM access_logs WHERE is_unlocked = true) as total_unlocks
    `);
    res.json(stats.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET: Usuarios con más actividad (Top 5)
app.get('/stats/top-users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.first_name, w.last_name, COUNT(al.id) as activity_count
      FROM access_logs al
      JOIN workers w ON al.nfc_card_id = w.id
      GROUP BY w.id, w.first_name, w.last_name
      ORDER BY activity_count DESC
      LIMIT 5
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});









// ==========================================
// RUTAS CRUD PARA USUARIOS (WORKERS)
// ==========================================





// GET: Leer todos los usuarios
// GET: Leer todos los usuarios
app.get('/workers', async (req, res) => {
  try {
    // CAMBIO: ORDER BY id ASC
    const result = await pool.query('SELECT * FROM workers ORDER BY id ASC'); 
    res.json(result.rows);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

// POST: Crear un nuevo usuario (CON CONTRASEÑA)
app.post('/workers', async (req, res) => {
  const { first_name, last_name, worker_code, access_level, password } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO workers (first_name, last_name, worker_code, access_level, password) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [first_name, last_name, worker_code, access_level || 0, password || '1234'] // 1234 por defecto si lo dejan vacío
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error al crear usuario en BD:", error.message);
    res.status(500).json({ error: 'Error creando usuario' });
  }
});

// PUT: Actualizar un usuario existente (CON CONTRASEÑA)
app.put('/workers/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, worker_code, access_level, password } = req.body;
  try {
    const result = await pool.query(
      `UPDATE workers 
       SET first_name = $1, last_name = $2, worker_code = $3, access_level = $4, password = $5 
       WHERE id = $6 RETURNING *`, 
      [first_name, last_name, worker_code, access_level, password, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando usuario' });
  }
});

// DELETE: Eliminar un usuario
app.delete('/workers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // CAMBIO: WHERE id = $1
    await pool.query('DELETE FROM workers WHERE id = $1', [id]); 
    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'No se puede eliminar.' });
  }
});


// GET: Obtener los logs de un usuario con Paginación y Filtro de Fecha
app.get('/logs/user/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const date = req.query.date;

    // CAMBIO: También agregamos el JOIN aquí por consistencia
    let queryStr = `
      SELECT al.*, w.first_name, w.last_name 
      FROM access_logs al
      LEFT JOIN workers w ON al.nfc_card_id = w.id
      WHERE al.nfc_card_id = $1
    `;
    let countQueryStr = 'SELECT COUNT(*) FROM access_logs al WHERE al.nfc_card_id = $1';
    let queryParams = [id];

    if (date) {
      queryStr += ' AND al.created_at::date = $2';
      countQueryStr += ' AND al.created_at::date = $2';
      queryParams.push(date);
    }

    const limitIndex = queryParams.length + 1;
    const offsetIndex = queryParams.length + 2;
    queryStr += ` ORDER BY al.created_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`;

    const [result, countResult] = await Promise.all([
      pool.query(queryStr, [...queryParams, limit, offset]),
      pool.query(countQueryStr, queryParams)
    ]);

    const totalItems = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalItems / limit);

    res.json({ data: result.rows, currentPage: page, totalPages: totalPages === 0 ? 1 : totalPages, totalItems });
  } catch (error) {
    console.error("Error filtrando logs paginados:", error.message);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});


// GET: Obtener logs en un rango de fechas para el Reporte PDF
app.get('/logs/report', async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const result = await pool.query(`
      SELECT 
        al.created_at, 
        w.first_name, 
        w.last_name, 
        al.lock_id, 
        al.action_type, 
        al.is_unlocked
      FROM access_logs al
      JOIN workers w ON al.nfc_card_id = w.id
      WHERE al.created_at::date >= $1 AND al.created_at::date <= $2
      ORDER BY al.created_at DESC
    `, [startDate, endDate]);
    
    res.json(result.rows);
  } catch (error) {
    console.error("Error generando datos para reporte:", error);
    res.status(500).json({ error: 'Error al generar datos del reporte' });
  }
});

// POST: Iniciar sesión
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


// GET: Consultar el estado actual del candado físico
app.get('/hardware/lock-status', async (req, res) => {
  try {
    // Buscamos el último log registrado del candado #1
    const result = await pool.query(`
      SELECT is_unlocked 
      FROM access_logs 
      WHERE lock_id = 1 
      ORDER BY created_at DESC 
      LIMIT 1
    `);

    // Si hay registros, devolvemos el estado. Si no hay, asumimos que está bloqueado (false)
    const isUnlocked = result.rows.length > 0 ? result.rows[0].is_unlocked : false;
    
    res.json({ unlocked: isUnlocked });
  } catch (error) {
    res.status(500).json({ error: 'Error leyendo estado del hardware' });
  }
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});
