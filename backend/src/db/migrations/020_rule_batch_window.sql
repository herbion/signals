-- Migration 020: a per-rule batching window.
--
-- Outbound grouping (migration 005) has one window for everything, 60s by
-- default -- right for "a ticket was assigned to you", which should arrive
-- promptly, and useless for "your certificate is ready", where a clerk marks
-- a pile of Довідки Здано over an hour and each one pinged the requester on
-- its own. A rule can now hold its messages for longer.
--
-- NULL means the global grouping window. A rule with a window queues its
-- messages even while grouping is switched off globally -- asking for a
-- window is asking for batching.
ALTER TABLE rules ADD COLUMN batch_window_seconds INTEGER;

-- Copied onto each queued row, because the dispatcher decides per row when a
-- recipient's batch is due: as soon as ANY queued row has waited out its own
-- window (and then everything queued for that person goes, longer-window rows
-- included -- one message instead of two).
ALTER TABLE message_log ADD COLUMN batch_window_seconds INTEGER;

-- A rule's comment-back for a queued message, already rendered, posted by the
-- dispatcher only once the batch has actually been sent -- with a 30-minute
-- window, commenting at queue time would claim "notified" half an hour early,
-- or falsely if the send then failed. Cleared once posted.
ALTER TABLE message_log ADD COLUMN pending_comment TEXT;
