-- Adds a "Gifting" jewellery type so products and parent products can be filed under it.
-- Runs once per database: if the business renames or deletes it later, it is not recreated.
INSERT INTO "categories" ("slug", "name", "description", "image", "group", "listing_rule", "seo", "display_order", "active")
VALUES (
  'gifting',
  'Gifting',
  'Gold and silver pieces for gifting.',
  '{"url":"https://images.unsplash.com/photo-1602752250055-5ebb552fc3ae?auto=format&fit=crop&w=1200&h=1500&q=80","alt":"Gold and silver heart pendant necklace","width":1200,"height":1500}'::jsonb,
  'type',
  NULL,
  '{}'::jsonb,
  11,
  true
)
ON CONFLICT ("slug") DO NOTHING;
