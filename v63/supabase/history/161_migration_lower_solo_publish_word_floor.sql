-- Migration 161: lower the solo-author publish word floor from 5,000 to 500
-- Product decision: 5,000 words excluded legitimate short stories from being published at all.
-- Anthology floor (min_anthology_publish_word_count, 50,000) and every naira-achievement /
-- referral "real book" check (still 30,000, unchanged) are untouched by this migration.
create or replace function min_publish_word_count()
returns integer as $$
  select 500;
$$ language sql immutable;
