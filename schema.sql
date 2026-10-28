-- Nutri: una sola tabla clave/valor con todos tus datos
CREATE TABLE IF NOT EXISTS store (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated TEXT
);
