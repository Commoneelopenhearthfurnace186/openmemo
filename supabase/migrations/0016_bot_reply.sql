ALTER TABLE inbound_message
  ADD COLUMN IF NOT EXISTS bot_reply text;
