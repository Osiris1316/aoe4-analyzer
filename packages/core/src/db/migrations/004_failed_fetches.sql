CREATE TABLE IF NOT EXISTS failed_fetches (
  game_id        INTEGER PRIMARY KEY,
  last_attempted TEXT NOT NULL,
  error          TEXT
);