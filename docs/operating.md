# Operating OpenMemo

Day-to-day commands once you have it running.

## Redeploy

After editing any Edge Function:

```bash
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy dispatch-reminder
supabase functions deploy calendar --no-verify-jwt
supabase functions deploy pulse
```

Or just re-run `./scripts/setup.sh`.

## Logs

```bash
supabase functions logs telegram-webhook --tail
supabase functions logs dispatch-reminder --tail
supabase functions logs pulse --tail
```

## Tests

```bash
deno task test
```

## Updating

```bash
git pull
./scripts/setup.sh
```

The installer is idempotent. New migrations apply, secrets push,
functions redeploy.

## Force the language

The bot mirrors your last message's language. Pin one:

```sql
UPDATE owner SET language = 'es' WHERE id = 1;  -- or 'en'
```

## Rotate the calendar URL

Delete the Cloudflare Pages project, re-run `./scripts/setup.sh`.

To rotate the token too:

```sql
UPDATE calendar_access SET token = encode(gen_random_bytes(24), 'hex')
WHERE id = 1;
```

Then re-run the installer.

## Add an optional feature later

Edit `.env`, add the keys, re-run `./scripts/setup.sh`. Done.
