CREATE OR REPLACE VIEW upcoming_birthdays AS
WITH today_local AS (
  SELECT (now() AT TIME ZONE COALESCE((SELECT timezone FROM owner WHERE id = 1), 'UTC'))::date AS d
)
SELECT
  f.id,
  f.name,
  f.birthday,
  CASE
    WHEN make_date(
           extract(year FROM (SELECT d FROM today_local))::int,
           extract(month FROM f.birthday)::int,
           LEAST(extract(day FROM f.birthday)::int, 28)
         ) >= (SELECT d FROM today_local)
      THEN make_date(
             extract(year FROM (SELECT d FROM today_local))::int,
             extract(month FROM f.birthday)::int,
             LEAST(extract(day FROM f.birthday)::int, 28)
           )
    ELSE make_date(
             extract(year FROM (SELECT d FROM today_local))::int + 1,
             extract(month FROM f.birthday)::int,
             LEAST(extract(day FROM f.birthday)::int, 28)
           )
  END AS next_birthday
FROM friend f
WHERE f.birthday IS NOT NULL
ORDER BY 4;
