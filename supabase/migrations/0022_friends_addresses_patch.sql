-- Catches up any prior partial application of 0021 by ensuring every
-- column and index exists exactly as expected.

CREATE TABLE IF NOT EXISTS friend (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text,
  phone       text,
  birthday    date,
  notes       text,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE friend ADD COLUMN IF NOT EXISTS birthday date;
ALTER TABLE friend ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE friend ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE friend ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS friend_name_idx ON friend (lower(name));
CREATE INDEX IF NOT EXISTS friend_tags_idx ON friend USING gin (tags);
CREATE INDEX IF NOT EXISTS friend_birthday_idx
  ON friend ((extract(month from birthday)), (extract(day from birthday)))
  WHERE birthday IS NOT NULL;

CREATE TABLE IF NOT EXISTS address (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  street      text,
  city        text,
  region      text,
  country     text,
  postal_code text,
  latitude    double precision,
  longitude   double precision,
  notes       text,
  friend_id   uuid REFERENCES friend(id) ON DELETE SET NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE address ADD COLUMN IF NOT EXISTS street text;
ALTER TABLE address ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE address ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE address ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE address ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE address ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE address ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE address ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE address ADD COLUMN IF NOT EXISTS friend_id uuid REFERENCES friend(id) ON DELETE SET NULL;
ALTER TABLE address ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE address ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='address' AND column_name='latitude')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='address' AND column_name='longitude')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'address_lat_lon_check' AND conrelid = 'address'::regclass
     ) THEN
    ALTER TABLE address ADD CONSTRAINT address_lat_lon_check CHECK (
      (latitude IS NULL AND longitude IS NULL) OR
      (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS address_label_idx ON address (lower(label));
CREATE INDEX IF NOT EXISTS address_friend_idx ON address (friend_id);
CREATE INDEX IF NOT EXISTS address_tags_idx ON address USING gin (tags);
ALTER TABLE address ENABLE ROW LEVEL SECURITY;
