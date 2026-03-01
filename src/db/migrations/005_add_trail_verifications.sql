-- Trail verifications: tracks which Facebook posts have been applied as status updates
CREATE TABLE IF NOT EXISTS trail_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id TEXT NOT NULL,
  trail_id UUID NOT NULL REFERENCES trails(id),
  classification TEXT NOT NULL,
  confidence_score NUMERIC NOT NULL,
  new_status TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trail_verifications_post_id ON trail_verifications(post_id);
CREATE INDEX IF NOT EXISTS idx_trail_verifications_trail_id ON trail_verifications(trail_id);
