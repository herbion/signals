-- signal-cli-rest-api's /v2/send takes a `text_mode` of "normal" or
-- "styled"; styled enables Signal's inline formatting (**bold**, *italic*,
-- ~strikethrough~, ||spoiler||, `monospace`). Defaults to styled here since
-- message templates are authored by an admin who wants the formatting;
-- flip to normal in Settings to send everything literally.
ALTER TABLE signal_settings ADD COLUMN text_mode TEXT NOT NULL DEFAULT 'styled'
  CHECK (text_mode IN ('normal', 'styled'));
