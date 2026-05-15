-- One-shot backfill: copy `identity.handle` onto `roommate.bsky_handle`
-- and `roommate.telegram_handle` for every existing roommate row that
-- doesn't already have a value set.
--
-- Going forward, `addRoommate` and `createRoomWithAdmin` populate these
-- columns at insert time from the caller's identity rows — so this
-- migration is effective once and idempotent thereafter (subsequent
-- runs find no NULL columns with a matching identity to fill).

UPDATE roommate
   SET bsky_handle = (
     SELECT i.handle FROM identity i
       WHERE i.user_id = roommate.user_id AND i.provider = 'bsky'
       ORDER BY i.created_at DESC LIMIT 1
   )
 WHERE bsky_handle IS NULL
   AND EXISTS (
     SELECT 1 FROM identity i2
       WHERE i2.user_id = roommate.user_id AND i2.provider = 'bsky'
   );

UPDATE roommate
   SET telegram_handle = (
     SELECT i.handle FROM identity i
       WHERE i.user_id = roommate.user_id AND i.provider = 'telegram'
       ORDER BY i.created_at DESC LIMIT 1
   )
 WHERE telegram_handle IS NULL
   AND EXISTS (
     SELECT 1 FROM identity i2
       WHERE i2.user_id = roommate.user_id AND i2.provider = 'telegram'
   );
