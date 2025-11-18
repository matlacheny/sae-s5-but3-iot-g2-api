import express from "express";
import sql from "mssql";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";

dotenv.config();
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

/*
  IMPORTANT: put secrets in App Service Configuration (not in .env for production).
  In local dev, create a .env with the values below for testing.
*/

// config via env
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, // ex: myserver.database.windows.net
    database: process.env.DB_NAME,
    options: {
        encrypt: true,
        enableArithAbort: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// create a single global pool
let poolPromise = null;
async function getPool() {
    if (!poolPromise) {
        poolPromise = sql.connect(dbConfig);
        // handle initial connect errors
        poolPromise.catch(err => {
            console.error("Initial DB connection error:", err);
            poolPromise = null;
        });
    }
    return poolPromise;
}

// sample route
app.get("/api/test", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query("SELECT * FROM TestItems;"); // adapte la table
        res.json(result.recordset);
    } catch (err) {
        console.error(err);0
        res.status(500).json({ error: "DB error", details: err.message });
    }
});

// health
app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on port ${port}`));
